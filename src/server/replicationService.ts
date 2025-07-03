import { RedisPubSub } from '../redis/RedisPubSub';
import { MetadataService } from './metadataService';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import path, { join } from 'path';
import { FileMetadata, Notification } from '../types';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { FileServer } from './FileServer';

const INTEGRITY_CHECK_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_INTERVAL = 5000; // 5 seconds
const REPLICATION_TIMEOUT = 10000; // 10 seconds

export class ReplicationService {
  private healthyNodes: Set<string> = new Set();
  private storagePath: string;
  private readonly isStorageNode = process.env.IS_STORAGE_NODE === 'true';
  private fileServer: FileServer

  private chunkBuffers = new Map<string, {
    chunks: Buffer[];
    totalChunks: number;
    checksums: string[];
  }>();

  constructor(
    private metadataService: MetadataService,
    private pubSub: RedisPubSub,
    storagePath: string = './nodes'
  ) {
    this.storagePath = storagePath;
    this.setupSubscriptions();
    this.fileServer = new FileServer(
      this.metadataService, this, storagePath)

    if (this.isStorageNode) {
      this.startHeartbeat();
      this.startIntegrityChecks();
    }
  }

  public async initialize() {
    await this.metadataService.loadAllFromRedis();
    this.monitorNodeHealth();
  }

  private setupSubscriptions() {
    // Heartbeat handling
    this.pubSub.subscribe('node_status', (msg: Notification) => {
      if (msg.event_type === 'NODE_HEARTBEAT') {
        const status = JSON.parse(msg.additional_info as string);
        this.metadataService.updateNodeStatus(status.nodeId, {
          ...status,
          lastHeartbeat: new Date()
        });
        this.healthyNodes.add(status.nodeId);
      }
    });

    // Chunk storage handling
    this.pubSub.subscribe(`chunk_node_${this.currentNodeId}`, this.handleChunkStore.bind(this));

    // File read requests handling
    this.pubSub.subscribe('file_read_requests', async (msg: Notification) => {
      const { requestId, targetNode } = JSON.parse(msg.additional_info || '{}');
      if (targetNode !== this.currentNodeId) return;

      try {
        const fullPath = path.join(this.storagePath, targetNode, msg.file_path);
        const content = await fs.readFile(fullPath, 'utf-8');

        await this.pubSub.publish(`file_read_responses:${requestId}`, {
          event_type: 'FILE_READ_RESPONSE',
          file_path: msg.file_path,
          timestamp: Date.now(),
          additional_info: JSON.stringify({ content })
        });
      } catch (e: any) {
        await this.pubSub.publish(`file_read_responses:${requestId}`, {
          event_type: 'FILE_READ_RESPONSE',
          file_path: msg.file_path,
          timestamp: Date.now(),
          additional_info: JSON.stringify({ error: e.message })
        });
      }
    });

    this.pubSub.subscribe('file_operations', async (msg: Notification) => {
      if (msg.event_type === 'FILE_OPERATION') {
        const { operation, content } = JSON.parse(msg.additional_info || '{}');
        await this.handleFileOperation(msg.file_path, operation, content);
      }
    });

    this.pubSub.subscribe('delete_requests', async (msg: Notification) => {
      if (msg.event_type !== 'DELETE_REQUEST') return;

      const { filename, sourceNode } = JSON.parse(msg.additional_info || '{}');

      // Evita loop de deleção
      if (sourceNode === this.currentNodeId) return;

      try {
        await this.fileServer.deleteFile(filename);
      } catch (err) {
        console.error(`Erro ao processar deleção de ${filename}:`, err);
      }
    });

    this.pubSub.subscribe(`chunk_request_${this.currentNodeId}`, async (msg: Notification) => {
      if (msg.event_type !== 'CHUNK_REQUEST') return;

      try {
        const { requestId, chunkNumber } = JSON.parse(msg.additional_info || '{}');
        const filename = msg.file_path;
        const chunkFilename = `${filename}.chunk${chunkNumber}`;
        const filePath = path.join(this.storagePath, this.currentNodeId, chunkFilename);

        const chunk = await fs.readFile(filePath);
        await this.pubSub.publish(`chunk_response_${requestId}`, {
          event_type: 'CHUNK_RESPONSE',
          file_path: filename,
          timestamp: Date.now(),
          additional_info: JSON.stringify({
            chunk: chunk.toString('base64')
          })
        });
      } catch (err) {

      }
    });
  }

  private async handleChunkStore(msg: Notification) {
    if (msg.event_type !== 'CHUNK_STORE') return;

    const data = JSON.parse(msg.additional_info as string);
    const chunkBuf = Buffer.from(data.chunk_base64, 'base64');

    await this.storeChunk({
      filename: data.filename,
      chunk: chunkBuf,
      chunkNumber: data.chunkNumber,
      totalChunks: data.totalChunks,
      checksum: data.checksum,
      isReplica: data.isReplica
    });
  }

  private async storeChunk(chunkData: {
    filename: string;
    chunk: Buffer;
    chunkNumber: number;
    totalChunks: number;
    checksum: string;
    isReplica: boolean;
  }) {
    // Verificação de checksum
    const calculatedChecksum = crypto.createHash('sha256')
      .update(chunkData.chunk)
      .digest('hex');

    if (calculatedChecksum !== chunkData.checksum) {
      throw new Error(`Checksum inválido para chunk ${chunkData.chunkNumber}`);
    }

    // Armazenamento físico
    const chunkFilename = `${chunkData.filename}.chunk${chunkData.chunkNumber}`;
    const filePath = path.join(this.storagePath, this.currentNodeId, chunkFilename);

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, chunkData.chunk);

    console.log(`Chunk ${chunkData.chunkNumber} armazenado no nó ${this.currentNodeId} como ${chunkFilename}`);
  }

  public async requestChunkFromNode(nodeId: string, filename: string, chunkNumber: number): Promise<{ chunk: Buffer }> {
    if (nodeId === this.currentNodeId) {
      // Se for o próprio nó, busca localmente
      const chunkFilename = `${filename}.chunk${chunkNumber}`;
      const filePath = path.join(this.storagePath, this.currentNodeId, chunkFilename);
      return {
        chunk: await fs.readFile(filePath)
      };
    }

    // Se for outro nó, faz requisição via Redis
    const requestId = crypto.randomUUID();
    const responseChannel = `chunk_response_${requestId}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pubSub.unsubscribe(responseChannel);
        reject(new Error('Timeout ao buscar chunk'));
      }, 500);

      this.pubSub.subscribe(responseChannel, (msg: Notification) => {
        clearTimeout(timeout);
        this.pubSub.unsubscribe(responseChannel);

        try {
          const { chunk, error } = JSON.parse(msg.additional_info || '{}');
          if (error) reject(new Error(error));
          else resolve({ chunk: Buffer.from(chunk, 'base64') });
        } catch (err) {
          reject(err);
        }
      });

      this.pubSub.publish(`chunk_request_${nodeId}`, {
        event_type: 'CHUNK_REQUEST',
        file_path: filename,
        timestamp: Date.now(),
        additional_info: JSON.stringify({
          requestId,
          chunkNumber
        })
      });
    });
  }

  private async handleFileOperation(
    filePath: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    content?: string
  ) {
    try {
      switch (operation) {
        case 'DELETE':
          await this.replicateDeleteOperation(filePath);
          break;
        case 'CREATE':
        case 'UPDATE':
          // Lógica existente para create/update
          break;
      }
    } catch (err) {
      console.error(`Erro ao processar operação ${operation} para ${filePath}:`, err);
    }
  }
  public async replicateDeleteOperation(filePath: string): Promise<void> {
    // 1. Verifica se o arquivo existe nos metadados
    const metadata = this.metadataService.getFileMetadata(filePath);
    if (!metadata) {
      console.warn(`Arquivo ${filePath} não encontrado nos metadados`);
      return;
    }

    // 2. Coleta todos os nós que possuem o arquivo (incluindo chunks)
    const allNodes = new Set<string>();
    if (metadata.chunkDistribution) {
      Object.values(metadata.chunkDistribution).forEach(nodes => {
        nodes.forEach(node => allNodes.add(node));
      });
    } else {
      // Para arquivos não chunked
      allNodes.add(metadata.primaryNode);
      metadata.replicaNodes.forEach(node => allNodes.add(node));
    }

    // 3. Envia comandos de deleção para todos os nós
    const deletionPromises = Array.from(allNodes).map(async node => {
      if (node !== this.currentNodeId) {
        try {
          await this.pubSub.publish('delete_requests', {
            event_type: 'DELETE_REQUEST',
            file_path: filePath,
            timestamp: Date.now(),
            additional_info: JSON.stringify({
              filename: filePath,
              sourceNode: this.currentNodeId
            })
          });
        } catch (err) {
          console.error(`Erro ao enviar delete para nó ${node}:`, err);
        }
      }
    });

    // 4. Deleta localmente e espera outras deleções (não bloqueante)
    await Promise.all([
      this.fileServer.deleteFile(filePath),
      ...deletionPromises
    ]);

    // 5. Remove metadados APÓS garantir a deleção local
    await this.metadataService.deleteFileMetadata(filePath);
  }

  private startHeartbeat() {
    setInterval(() => {
      this.pubSub.publish('node_status', {
        event_type: 'NODE_HEARTBEAT',
        file_path: '',
        timestamp: Date.now(),
        additional_info: JSON.stringify({
          nodeId: this.currentNodeId,
          status: 'ONLINE',
          lastHeartbeat: new Date(),
          storageCapacity: this.getStorageCapacity(),
          storageUsed: this.getStorageUsed()
        })
      });
    }, HEARTBEAT_INTERVAL);
  }

  private monitorNodeHealth() {
    setInterval(() => {
      const now = Date.now();
      const TIMEOUT = 15000; // 15 segundos

      for (const nodeId of this.healthyNodes) {
        const status = this.metadataService.getNodeStatusSync(nodeId);
        if (!status || (now - new Date(status.lastHeartbeat).getTime()) > TIMEOUT) {
          console.warn(`[HEALTHCHECK] Nó ${nodeId} está offline`);
          this.healthyNodes.delete(nodeId);
          this.metadataService.updateNodeStatus(nodeId, {
            nodeId,
            status: 'OFFLINE',
            lastHeartbeat: new Date(),
            storageCapacity: status?.storageCapacity || 0,
            storageUsed: status?.storageUsed || 0
          });
        }
      }
    }, 5000);
  }

  private startIntegrityChecks() {
    setInterval(() => {
      this.verifyReplicaIntegrity().catch(console.error);
    }, INTEGRITY_CHECK_INTERVAL);
  }

  public async handleIncomingChunk(chunkData: {
    filename: string;
    chunk: Buffer;
    chunkNumber: number;
    totalChunks: number;
    checksum: string;
    targetNodes: string[];
  }): Promise<void> {
    const { filename, chunk, chunkNumber, totalChunks, checksum, targetNodes } = chunkData;

    // 1. Store chunk temporarily
    if (!this.chunkBuffers.has(filename)) {
      this.chunkBuffers.set(filename, {
        chunks: Array(totalChunks),
        totalChunks,
        checksums: []
      });
    }

    const fileData = this.chunkBuffers.get(filename)!;
    fileData.chunks[chunkNumber] = chunk;
    fileData.checksums.push(checksum);

    // 2. Save chunk to local storage
    const nodePath = path.join(this.storagePath, this.currentNodeId);
    await fs.mkdir(nodePath, { recursive: true });

    const tempPath = path.join(nodePath, `${filename}.part`);
    await fs.appendFile(tempPath, chunk);

    // 3. If last chunk, finalize file
    if (chunkNumber === totalChunks - 1) {
      const finalPath = path.join(nodePath, filename);
      await fs.rename(tempPath, finalPath);

      // Update metadata if primary node
      if (this.isPrimaryNode) {
        const content = await fs.readFile(finalPath, 'utf-8');
        const fileChecksum = this.calculateChecksumFromString(content);

        const existing = this.metadataService.getFileMetadata(filename);
        if (!existing) {
          await this.metadataService.registerFile(filename, this.currentNodeId, targetNodes);
        }

        await this.metadataService.updateFileMetadata(filename, {
          version: (existing?.version || 0) + 1,
          checksum: fileChecksum,
          lastUpdated: new Date(),
          size: content.length
        });
      }

      this.chunkBuffers.delete(filename);
    }
  }

  private async verifyReplicaIntegrity(): Promise<void> {
    if (!this.isStorageNode) return;

    for (const file of this.metadataService.getAllFiles()) {
      const meta = this.metadataService.getFileMetadata(file);
      if (!meta) continue;

      const isPrimary = meta.primaryNode === this.currentNodeId;
      const isReplica = meta.replicaNodes.includes(this.currentNodeId);

      if (!isPrimary && !isReplica) continue;

      const filePath = path.join(this.storagePath, this.currentNodeId, file);

      try {
        if (!existsSync(filePath)) {
          if (isPrimary) {
            await this.recoverPrimaryFile(file, meta);
          } else {
            await this.recoverReplicaFile(file, meta);
          }
          continue;
        }

        const localChecksum = this.calculateChecksum(filePath);

        if (isPrimary) {
          await this.verifyPrimaryReplicas(file, meta, localChecksum);
        } else {
          await this.verifyReplicaAgainstPrimary(file, meta, localChecksum);
        }
      } catch (err) {
        console.error(`[INTEGRITY] Erro verificando ${file}:`, err);
      }
    }
  }

  private async recoverPrimaryFile(filename: string, meta: FileMetadata) {
    const replicaWithFile = meta.replicaNodes.find(async node => {
      try {
        await this.requestChecksum(node, filename);
        return true;
      } catch {
        return false;
      }
    });

    if (replicaWithFile) {
      await this.replicateFileFromNode(filename, replicaWithFile);
    } else {
      await this.metadataService.deleteFileMetadata(filename);
    }
  }

  private async recoverReplicaFile(filename: string, meta: FileMetadata) {
    try {
      await this.requestChecksum(meta.primaryNode, filename);
      await this.replicateFileFromNode(filename, meta.primaryNode);
    } catch {
      await fs.unlink(path.join(this.storagePath, this.currentNodeId, filename)).catch(() => { });
      await this.metadataService.updateFileMetadata(filename, {
        replicaNodes: meta.replicaNodes.filter(n => n !== this.currentNodeId)
      });
    }
  }

  private async verifyPrimaryReplicas(filename: string, meta: FileMetadata, primaryChecksum: string) {
    for (const replica of meta.replicaNodes) {
      if (replica === this.currentNodeId) continue;

      try {
        const replicaChecksum = await this.requestChecksum(replica, filename);
        if (replicaChecksum !== primaryChecksum) {
          await this.replicateFileToNode(filename, replica);
        }
      } catch {
        this.healthyNodes.delete(replica);
      }
    }
  }

  private async verifyReplicaAgainstPrimary(filename: string, meta: FileMetadata, replicaChecksum: string) {
    try {
      const primaryChecksum = await this.requestChecksum(meta.primaryNode, filename);
      if (primaryChecksum !== replicaChecksum) {
        await this.replicateFileFromNode(filename, meta.primaryNode);
      }
    } catch {
      console.log(`[INTEGRITY] Primário inacessível para ${filename}`);
    }
  }

  private async replicateFileFromNode(filename: string, sourceNode: string) {
    const requestId = crypto.randomUUID();
    const responseChannel = `file_read_responses:${requestId}`;

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pubSub.unsubscribe(responseChannel);
        reject(new Error('Timeout ao recuperar arquivo'));
      }, REPLICATION_TIMEOUT);

      this.pubSub.subscribe(responseChannel, async (msg: Notification) => {
        clearTimeout(timeout);
        this.pubSub.unsubscribe(responseChannel);

        try {
          const { content, error } = JSON.parse(msg.additional_info || '{}');
          if (error) throw new Error(error);

          const nodePath = path.join(this.storagePath, this.currentNodeId);
          await fs.mkdir(nodePath, { recursive: true });
          await fs.writeFile(path.join(nodePath, filename), content);
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      this.pubSub.publish('file_read_requests', {
        event_type: 'FILE_READ_REQUEST',
        file_path: filename,
        timestamp: Date.now(),
        additional_info: JSON.stringify({ requestId, targetNode: sourceNode })
      });
    });
  }

  private async replicateFileToNode(filename: string, targetNode: string) {
    const filePath = path.join(this.storagePath, this.currentNodeId, filename);
    const content = await fs.readFile(filePath, 'utf-8');
    const checksum = this.calculateChecksumFromString(content);
    const meta = this.metadataService.getFileMetadata(filename);

    await this.pubSub.publish('chunk_store', {
      event_type: 'CHUNK_STORE',
      file_path: filename,
      timestamp: Date.now(),
      additional_info: JSON.stringify({
        filename,
        chunk_base64: Buffer.from(content).toString('base64'),
        chunkNumber: 0,
        totalChunks: 1,
        checksum,
        targetNodes: [targetNode]
      })
    });
  }

  private async requestChecksum(nodeId: string, filename: string): Promise<string> {
    if (nodeId === this.currentNodeId) {
      const filePath = path.join(this.storagePath, this.currentNodeId, filename);
      return this.calculateChecksum(filePath);
    }

    const requestId = crypto.randomUUID();
    const responseChannel = `checksum_responses:${requestId}`;

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pubSub.unsubscribe(responseChannel);
        reject(new Error('Timeout ao verificar checksum'));
      }, REPLICATION_TIMEOUT);

      this.pubSub.subscribe(responseChannel, (msg: Notification) => {
        clearTimeout(timeout);
        this.pubSub.unsubscribe(responseChannel);
        const { checksum, error } = JSON.parse(msg.additional_info || '{}');
        error ? reject(new Error(error)) : resolve(checksum);
      });

      this.pubSub.publish('checksum_requests', {
        event_type: 'CHECKSUM_REQUEST',
        file_path: filename,
        timestamp: Date.now(),
        additional_info: JSON.stringify({ requestId, targetNode: nodeId })
      });
    });
  }

  private calculateChecksum(filePath: string): string {
    const content = readFileSync(filePath, 'utf-8');
    return this.calculateChecksumFromString(content);
  }

  private calculateChecksumFromString(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private getStorageCapacity(): number {
    return 1024 * 1024 * 1024; // 1GB
  }

  private getStorageUsed(): number {
    const nodePath = path.join(this.storagePath, this.currentNodeId);
    if (!existsSync(nodePath)) return 0;

    const files = readdirSync(nodePath, { recursive: true, encoding: 'utf-8' });
    return files.reduce((total, file) => {
      try {
        const filePath = path.join(nodePath, file.toString());
        const stats = statSync(filePath);
        return stats.isFile() ? total + stats.size : total;
      } catch (err) {
        console.error(`Error getting stats for ${file}:`, err);
        return total;
      }
    }, 0);
  }

  public get currentNodeId(): string {
    return process.env.NODE_ID || 'server';
  }

  private get isPrimaryNode(): boolean {
    return process.env.IS_PRIMARY_NODE === 'true';
  }
}