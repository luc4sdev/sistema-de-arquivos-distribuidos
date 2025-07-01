import { RedisPubSub } from '../redis/RedisPubSub';
import { MetadataService } from './metadataService';
import { readFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import path, { join } from 'path';
import { FileMetadata, Notification } from '../types';
import * as crypto from 'crypto';
import { FileServer } from './FileServer';
import * as fs from 'fs/promises'

const INTEGRITY_CHECK_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_INTERVAL = 5000; // 5 seconds
const REPLICATION_TIMEOUT = 10000; // 10 seconds

export class ReplicationService {
  private healthyNodes: Set<string> = new Set();
  public currentNodeId: string;
  private storagePath: string;
  private fileServer: FileServer;
  private readonly isStorageNode = process.env.IS_STORAGE_NODE === 'true';

  private chunkBuffers = new Map<string, {
    chunks: Buffer[];
    totalChunks: number;
    checksums: string[];
    metadata?: FileMetadata;
  }>();

  constructor(
    private metadataService: MetadataService,
    private pubSub: RedisPubSub,
    nodeId: string,
    storagePath: string = './nodes'
  ) {
    this.currentNodeId = nodeId;
    this.storagePath = storagePath;
    this.setupSubscriptions();

    if (this.isStorageNode) {
      this.startHeartbeat();
      this.startIntegrityChecks();
    }


    this.fileServer = new FileServer(this.metadataService, this, this.storagePath);
  }

  public async initialize() {
    if (this.isStorageNode) {
      this.metadataService.registerNode(this.currentNodeId, {
        nodeId: this.currentNodeId,
        status: 'ONLINE',
        lastHeartbeat: new Date(),
        storageCapacity: this.getStorageCapacity(),
        storageUsed: this.getStorageUsed()
      });
    }

    await this.metadataService.loadAllMetadataFromRedis();
    // Inicializa healthyNodes com base nos nós já conhecidos com status ONLINE
    const allNodes = this.metadataService.getAllNodes();
    for (const nodeId of Object.keys(allNodes)) {
      const node = allNodes[nodeId];
      if (node.status === 'ONLINE') {
        this.healthyNodes.add(nodeId);
      }
    }
    console.log('[INIT] healthyNodes inicializados:', Array.from(this.healthyNodes));
    this.monitorNodeHealth();
    if (this.isStorageNode) {
      this.pubSub.publish('node_sync', {
        event_type: 'NODE_JOIN',
        file_path: '',
        timestamp: Date.now(),
        additional_info: JSON.stringify({ nodeId: this.currentNodeId })
      });
    }

  }

  private setupSubscriptions() {
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


    if (process.env.IS_PRIMARY_NODE === 'true') {
      this.pubSub.subscribe('file_operations', (msg: Notification) => {
        const { operation, content } =
          JSON.parse(msg.additional_info as string);
        if (msg.event_type === 'FILE_OPERATION') {
          this.replicateFileOperation(msg.file_path, operation, content);
        }
      });
    }

    if (process.env.IS_PRIMARY_NODE === 'true') {
      this.pubSub.subscribe('file_chunks', async (msg: Notification) => {
        if (msg.event_type !== 'FILE_CHUNK') return;
        try {
          const data = JSON.parse(msg.additional_info as string);

          // Reverte o chunk de base64 p/ Buffer
          const chunkBuf = Buffer.from(data.chunk, 'base64');

          await this.handleIncomingChunk({
            filename: data.filename,
            chunk: chunkBuf,
            chunkNumber: data.chunkNumber,
            totalChunks: data.totalChunks,
            checksum: data.checksum,
            sourceNode: data.sourceNode
          });
        } catch (err) {
          console.error('[CHUNK] Erro ao processar FILE_CHUNK:', err);
        }
      });
    }

    if (!process.env.IS_PRIMARY_NODE && process.env.IS_STORAGE_NODE === 'true') {
      this.pubSub.subscribe('chunk_replication', async (msg: Notification) => {
        if (msg.event_type !== 'CHUNK_REPLICATION') return;
        try {
          const data = JSON.parse(msg.additional_info as string);

          // Reverte o chunk de base64 p/ Buffer
          const chunkBuf = Buffer.from(data.chunk, 'base64');

          await this.handleIncomingChunk({
            filename: data.filename,
            chunk: chunkBuf,
            chunkNumber: data.chunkNumber,
            totalChunks: data.totalChunks,
            checksum: data.checksum,
            sourceNode: data.sourceNode
          });
        } catch (err) {
          console.error('[CHUNK] Erro ao processar FILE_CHUNK:', err);
        }
      });

    }


    this.pubSub.subscribe('replication_requests', (msg: Notification) => {
      if (msg.event_type === 'REPLICATION_REQUEST') {
        this.handleReplicationRequest(msg);
      }
    });

    this.pubSub.subscribe('checksum_requests', (msg: Notification) => {
      if (msg.event_type === 'CHECKSUM_REQUEST') {
        this.handleChecksumRequest(msg);
      }
    });

    this.pubSub.subscribe('node_sync', async (msg: Notification) => {
      if (msg.event_type === 'NODE_JOIN') {
        const { nodeId } = JSON.parse(msg.additional_info || '{}');
        if (nodeId !== this.currentNodeId) {
          this.healthyNodes.add(nodeId);
          if (this.isStorageNode) this.syncFilesToNewNode(nodeId);
        }
      }
    });

    this.pubSub.subscribe('file_read_requests', async (msg: Notification) => {
      const { requestId, targetNode } = JSON.parse(msg.additional_info || '{}');
      if (targetNode !== this.currentNodeId) return;

      try {
        const fullPath = this.getFilePath(msg.file_path);
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

    this.pubSub.subscribe('file_list_requests', async (msg: Notification) => {
      const { requestId, targetNode } = JSON.parse(msg.additional_info || '{}');

      if (targetNode !== this.currentNodeId) return; // Garante que só o nó certo responde

      const responseChannel = `file_list_responses:${requestId}`;

      try {
        const nodePath = path.join(this.storagePath, this.currentNodeId);

        const files = await this.getAllFilesRecursively(nodePath);
        console.log(files)
        await this.pubSub.publish(responseChannel, {
          event_type: 'FILE_LIST_RESPONSE',
          file_path: '',
          timestamp: Date.now(),
          additional_info: JSON.stringify({ files })
        });

      } catch (err) {
        await this.pubSub.publish(responseChannel, {
          event_type: 'FILE_LIST_RESPONSE',
          file_path: '',
          timestamp: Date.now(),
          additional_info: JSON.stringify({ error: (err as Error).message })
        });
      }
    });




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
      console.log('[HEARTBEAT] Enviado de', this.currentNodeId)
    }, HEARTBEAT_INTERVAL);
  }

  private monitorNodeHealth() {
    setInterval(() => {
      const now = Date.now();
      const TIMEOUT = 15000; // 15 segundos
      console.log('[HEALTHCHECK] Verificando nós...');
      for (const [nodeId, status] of Object.entries(this.metadataService.getAllNodes())) {
        const last = new Date(status.lastHeartbeat).getTime();
        if ((now - last) > TIMEOUT) {
          if (this.healthyNodes.has(nodeId)) {
            console.warn(`[HEALTHCHECK] Nó ${nodeId} está offline (último heartbeat há ${now - last} ms)`);
            this.healthyNodes.delete(nodeId);
            this.metadataService.updateNodeStatus(nodeId, {
              nodeId,
              status: 'OFFLINE',
              lastHeartbeat: new Date(),
              storageCapacity: status.storageCapacity,
              storageUsed: status.storageUsed
            });
          }
        }
      }
    }, 5000); // verifica a cada 5s
  }


  private startIntegrityChecks() {
    setInterval(() => {
      this.verifyReplicaIntegrity().catch(console.error);
    }, INTEGRITY_CHECK_INTERVAL);
  }

  public async replicateFileOperation(
    filePath: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    content?: string
  ): Promise<{ newVersion: number, checksum: string }> {
    let metadata = this.metadataService.getFileMetadata(filePath);

    // Se for CREATE e não existir metadado, registrar novo
    if (operation === 'CREATE' && !metadata) {
      const replicaNodes = this.metadataService.findNewReplicaCandidates([this.currentNodeId]);
      await this.metadataService.registerFile(filePath, this.currentNodeId, replicaNodes);
      metadata = this.metadataService.getFileMetadata(filePath);
    }

    if (!metadata) {
      throw new Error(`Metadados não encontrados para ${filePath}`);
    }

    await this.processLocalOperation(filePath, operation, content || '');

    const newVersion = metadata.version + 1;
    const checksum = content ? this.calculateChecksumFromString(content) : '';

    if (operation === 'UPDATE') {
      this.metadataService.updateFileMetadata(filePath, {
        version: newVersion,
        checksum,
        lastUpdated: new Date(),
        size: content?.length || 0
      });
    }

    await this.sendToReplicas(filePath, operation, content || '', newVersion, checksum);
    if (operation === 'DELETE') {
      await this.metadataService.deleteFileMetadata(filePath);
    }
    return { newVersion, checksum };
  }


  private async processLocalOperation(
    filePath: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    content: string
  ) {
    try {
      switch (operation) {
        case 'CREATE':
          await this.fileServer.createFile({
            filename: filePath,
            content
          });
          break;
        case 'UPDATE':
          this.fileServer.writeFile({
            filename: filePath,
            content
          });
          break;
        case 'DELETE':
          await this.fileServer.deleteFile({
            filename: filePath
          });
          break;
      }
    } catch (err) {
      console.error(`Falha ao processar operação ${operation} para ${filePath}:`, err);
      throw err;
    }
  }

  public async sendToReplicas(
    filePath: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    content: string,
    version: number,
    checksum: string,
    targetNodesOverride?: string[]
  ) {
    const metadata = this.metadataService.getFileMetadata(filePath);
    if (!metadata) return;

    const targets = (targetNodesOverride ?? metadata.replicaNodes)
      .filter(node => this.isStorageNodeId(node) && node !== this.currentNodeId);

    if (!targets.length) return;

    await this.pubSub.publish('replication_requests', {
      event_type: 'REPLICATION_REQUEST',
      file_path: filePath,
      timestamp: Date.now(),
      additional_info: JSON.stringify({
        operation,
        content,
        version,
        checksum,
        sourceNode: this.currentNodeId,
        targetNodes: targets
      })
    });
  }

  private async handleReplicationRequest(msg: Notification) {
    const { operation, content, version, checksum, sourceNode, targetNodes } =
      JSON.parse(msg.additional_info as string);

    console.log(`Recebendo replicação: ${msg.file_path} de ${sourceNode} para ${targetNodes.join(', ')}`);
    console.log(`Operação: ${operation}, Versão: ${version}, Checksum: ${checksum}`);

    // Ignorar mensagens não destinadas a este nó
    if (sourceNode === this.currentNodeId || !targetNodes.includes(this.currentNodeId)) {
      return;
    }

    const filePath = msg.file_path;
    try {
      await this.processLocalOperation(filePath, operation as any, content);

      if (operation !== 'DELETE') {
        if (!this.metadataService.getFileMetadata(filePath))
          await this.metadataService.registerFile(filePath, sourceNode, []);

        await this.metadataService.updateFileMetadata(filePath, {
          version, checksum, lastUpdated: new Date(),
          size: operation === 'DELETE' ? 0 : content.length
        });
      }
    } catch (err) {
      console.error(`Falha ao processar replicação para ${filePath}:`, err);
    }
  }

  private async requestChecksum(nodeId: string, filePath: string): Promise<string> {
    if (nodeId === this.currentNodeId) {
      return this.calculateChecksum(this.getFilePath(filePath));
    }

    const requestId = crypto.randomUUID();
    const responseChannel = `checksum_responses:${requestId}`;

    return new Promise<string>((res, rej) => {
      const t = setTimeout(() => {
        this.pubSub.unsubscribe(responseChannel); rej(new Error('Timeout checksum'));
      }, REPLICATION_TIMEOUT);

      this.pubSub.subscribe(responseChannel, (m: Notification) => {
        clearTimeout(t);
        this.pubSub.unsubscribe(responseChannel);
        res(JSON.parse(m.additional_info!).checksum);
      });

      this.pubSub.publish('checksum_requests', {
        event_type: 'CHECKSUM_REQUEST',
        file_path: filePath,
        timestamp: Date.now(),
        additional_info: JSON.stringify({ targetNode: nodeId, requestId })
      });
    });
  }

  private async handleChecksumRequest(msg: Notification) {
    const { sourceNode, targetNode, requestId } = JSON.parse(msg.additional_info || '{}');
    const filePath = msg.file_path;

    if (targetNode !== this.currentNodeId) return;

    try {
      const checksum = this.calculateChecksum(this.getFilePath(filePath));

      await this.pubSub.publish(`checksum_responses:${requestId}`, {
        event_type: 'CHECKSUM_RESPONSE',
        file_path: filePath,
        timestamp: Date.now(),
        additional_info: JSON.stringify({ checksum })
      });
    } catch (err) {
      console.error(`Erro ao responder checksum de ${filePath} para ${sourceNode}:`, err);
    }
  }

  private async verifyReplicaIntegrity(): Promise<void> {
    // Verifica apenas se este processo é nó de armazenamento
    if (!this.isStorageNode) return;

    console.log('[INTEGRITY] Iniciando verificação de integridade...');

    try {
      // 1. Verificar arquivos onde este nó é primário
      const filesAsPrimary = this.metadataService.getAllFiles()
        .filter(f => {
          const meta = this.metadataService.getFileMetadata(f);
          return meta?.primaryNode === this.currentNodeId;
        });

      for (const file of filesAsPrimary) {
        await this.verifyFileIntegrity(file, true);
      }

      // 2. Verificar arquivos onde este nó é réplica
      const filesAsReplica = this.metadataService.getAllFiles()
        .filter(f => {
          const meta = this.metadataService.getFileMetadata(f);
          return meta?.replicaNodes.includes(this.currentNodeId) &&
            meta.primaryNode !== this.currentNodeId;
        });

      for (const file of filesAsReplica) {
        await this.verifyFileIntegrity(file, false);
      }
    } catch (err) {
      console.error('[INTEGRITY] Erro durante verificação:', err);
    }
  }

  private async verifyFileIntegrity(filename: string, isPrimary: boolean): Promise<void> {
    const metadata = this.metadataService.getFileMetadata(filename);
    if (!metadata) return;

    const localPath = this.getFilePath(filename);

    try {
      // Verificar se arquivo existe localmente
      if (!existsSync(localPath)) {
        if (isPrimary) {
          // Se é primário e não tem o arquivo, verificar se réplicas têm
          const replicaWithFile = await this.findReplicaWithFile(filename);
          if (replicaWithFile) {
            console.log(`[INTEGRITY] Primário sem arquivo ${filename}, recuperando de réplica ${replicaWithFile}`);
            await this.recoverFileFromReplica(filename, replicaWithFile);
          } else {
            console.log(`[INTEGRITY] Arquivo ${filename} não existe em nenhum nó, removendo metadados`);
            await this.metadataService.deleteFileMetadata(filename);
          }
        } else {
          // Se é réplica e não tem o arquivo, verificar se primário tem
          if (await this.checkIfPrimaryHasFile(filename)) {
            console.log(`[INTEGRITY] Réplica sem arquivo ${filename}, recuperando do primário`);
            await this.replicateToNode(filename, this.currentNodeId);
          } else {
            console.log(`[INTEGRITY] Arquivo ${filename} não existe no primário, removendo localmente`);
            await this.fileServer.deleteFile({ filename });
            await this.metadataService.updateFileMetadata(filename, {
              replicaNodes: metadata.replicaNodes.filter(n => n !== this.currentNodeId)
            });
          }
        }
        return;
      }

      // Verificar checksum local
      const localChecksum = this.calculateChecksum(localPath);

      if (isPrimary) {
        // Verificar réplicas
        for (const replica of metadata.replicaNodes) {
          if (replica === this.currentNodeId) continue;

          try {
            const replicaChecksum = await this.requestChecksum(replica, filename);
            if (replicaChecksum !== localChecksum) {
              console.log(`[INTEGRITY] Réplica ${replica} fora de sincronia para ${filename}, replicando...`);
              await this.replicateToNode(filename, replica);
            }
          } catch (err) {
            console.log(`[INTEGRITY] Réplica ${replica} inacessível para ${filename}`);
            this.healthyNodes.delete(replica);
          }
        }
      } else {
        // Verificar contra primário
        try {
          const primaryChecksum = await this.requestChecksum(metadata.primaryNode, filename);
          if (primaryChecksum !== localChecksum) {
            console.log(`[INTEGRITY] Réplica fora de sincronia com primário para ${filename}, atualizando...`);
            await this.replicateToNode(filename, this.currentNodeId);
          }
        } catch (err) {
          console.log(`[INTEGRITY] Primário inacessível para ${filename}`);
        }
      }
    } catch (err) {
      console.error(`[INTEGRITY] Erro ao verificar integridade de ${filename}:`, err);
    }
  }

  private async findReplicaWithFile(filename: string): Promise<string | null> {
    const metadata = this.metadataService.getFileMetadata(filename);
    if (!metadata) return null;

    for (const replica of metadata.replicaNodes) {
      try {
        await this.requestChecksum(replica, filename);
        return replica;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async checkIfPrimaryHasFile(filename: string): Promise<boolean> {
    const metadata = this.metadataService.getFileMetadata(filename);
    if (!metadata) return false;

    try {
      await this.requestChecksum(metadata.primaryNode, filename);
      return true;
    } catch {
      return false;
    }
  }

  private async recoverFileFromReplica(filename: string, sourceNode: string): Promise<void> {
    try {
      const { content } = await this.fileServer.readFileWithFallback({
        filename,
        preferredNode: sourceNode,
        replicaNodes: []
      });

      if (content) {
        await this.fileServer.createFile({ filename, content });
        console.log(`[INTEGRITY] Arquivo ${filename} recuperado de ${sourceNode}`);
      }
    } catch (err) {
      console.error(`[INTEGRITY] Falha ao recuperar arquivo ${filename} de ${sourceNode}:`, err);
    }
  }

  private async syncFilesToNewNode(newNodeId: string): Promise<void> {
    if (!this.isStorageNodeId(newNodeId)) return;

    /* envia arquivos válidos */
    for (const file of this.metadataService.getAllFiles()) {
      const meta = this.metadataService.getFileMetadata(file)!;
      if (meta.replicaNodes.includes(newNodeId)) continue;        // já é réplica

      const { content } = await this.fileServer.readFileWithFallback({
        filename: file,
        preferredNode: meta.primaryNode,
        replicaNodes: meta.replicaNodes
      });

      if (!content) continue;

      await this.sendToReplicas(
        file, 'CREATE', content, meta.version,
        this.calculateChecksumFromString(content), [newNodeId]
      );

      await this.metadataService.updateFileMetadata(file, {
        replicaNodes: [...meta.replicaNodes, newNodeId],
        lastUpdated: new Date()
      });
    }
  }

  private async replicateToNode(filePath: string, targetNode: string): Promise<void> {
    if (!this.isStorageNodeId(targetNode)) return;

    const content = readFileSync(this.getFilePath(filePath), 'utf-8');
    const meta = this.metadataService.getFileMetadata(filePath);
    if (!meta) return;

    await this.sendToReplicas(
      filePath, 'UPDATE', content, meta.version,
      this.calculateChecksumFromString(content), [targetNode]
    );
  }

  public async handleIncomingChunk(chunk: {
    filename: string;
    chunk: Buffer;
    chunkNumber: number;
    totalChunks: number;
    checksum: string;
    sourceNode: string;
  }): Promise<void> {
    console.log(`[CHUNK] Recebendo pedaço ${chunk.chunkNumber + 1}/${chunk.totalChunks} de ${chunk.sourceNode} para ${chunk.filename}`);

    // 1. Armazenar o chunk temporariamente
    if (!this.chunkBuffers.has(chunk.filename)) {
      this.chunkBuffers.set(chunk.filename, {
        chunks: Array(chunk.totalChunks),
        totalChunks: chunk.totalChunks,
        checksums: []
      });
    }

    const fileData = this.chunkBuffers.get(chunk.filename)!;
    fileData.chunks[chunk.chunkNumber] = chunk.chunk;
    fileData.checksums.push(chunk.checksum);

    // 2. Salvar localmente
    await this.fileServer.handleFileChunk(chunk);

    // 4. Se for o último chunk, finalizar o processo
    const isLastChunk = chunk.chunkNumber === chunk.totalChunks - 1;
    if (isLastChunk) {
      console.log(`[CHUNK] ${chunk.filename} completo. Finalizando processo...`);

      const fullPath = this.getFilePath(chunk.filename);
      const content = await fs.readFile(fullPath, 'utf-8');
      const checksum = this.calculateChecksumFromString(content);

      if (process.env.IS_PRIMARY_NODE === 'true') {
        // Se for o primário, atualizar metadados
        const existing = this.metadataService.getFileMetadata(chunk.filename);
        if (!existing) {
          const replicas = this.metadataService.findNewReplicaCandidates([this.currentNodeId]);
          await this.metadataService.registerFile(chunk.filename, this.currentNodeId, replicas);
        }
        await this.metadataService.updateFileMetadata(chunk.filename, {
          version: 1,
          checksum,
          lastUpdated: new Date(),
          size: content.length
        });

        for (let i = 0; i < fileData.totalChunks; i++) {
          await this.replicateChunk({
            filename: chunk.filename,
            chunk: fileData.chunks[i],
            chunkNumber: i,
            totalChunks: fileData.totalChunks,
            checksum: fileData.checksums[i],
            sourceNode: this.currentNodeId
          });
        }
      }
      this.chunkBuffers.delete(chunk.filename);
    }
  }

  private async replicateChunk(chunk: {
    filename: string;
    chunk: Buffer;
    chunkNumber: number;
    totalChunks: number;
    checksum: string;
    sourceNode: string;
  }): Promise<void> {
    const metadata = this.metadataService.getFileMetadata(chunk.filename);
    if (!metadata) return;

    const targetNodes = metadata.replicaNodes
      .filter(node => node !== this.currentNodeId && this.healthyNodes.has(node));

    if (targetNodes.length === 0) return;

    console.log(`[CHUNK] Replicando chunk ${chunk.chunkNumber + 1}/${chunk.totalChunks} para ${targetNodes.join(', ')}`);

    await this.pubSub.publish('chunk_replication', {
      event_type: 'CHUNK_REPLICATION',
      file_path: chunk.filename,
      timestamp: Date.now(),
      additional_info: JSON.stringify({
        filename: chunk.filename,
        chunk: chunk.chunk.toString('base64'),
        chunkNumber: chunk.chunkNumber,
        totalChunks: chunk.totalChunks,
        checksum: chunk.checksum,
        sourceNode: this.currentNodeId,
        targetNodes
      })
    });
  }

  private async getAllFilesRecursively(basePath: string): Promise<{ name: string, is_directory: boolean }[]> {
    const results: { name: string, is_directory: boolean }[] = [];

    const walk = async (dir: string, prefix = '') => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const relPath = path.join(prefix, entry.name);
        results.push({ name: relPath, is_directory: entry.isDirectory() });

        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), relPath);
        }
      }
    };

    await walk(basePath);
    return results;
  }

  /* ---------- UTIL ---------- */

  private getFilePath(filePath: string): string {
    return join(this.storagePath, this.currentNodeId, filePath);
  }

  private calculateChecksum(filePath: string): string {
    return this.calculateChecksumFromString(readFileSync(filePath, 'utf-8'));
  }

  public calculateChecksumFromString(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private getStorageCapacity(): number {
    return 1024 * 1024 * 1024; // 1GB
  }

  private getStorageUsed(): number {
    const files = this.metadataService.getAllFiles();
    return files.reduce((total, file) => {
      const metadata = this.metadataService.getFileMetadata(file);
      return total + (metadata?.size || 0);
    }, 0);
  }

  private isStorageNodeId(id: string) {
    return id !== 'server' && this.healthyNodes.has(id);
  }
}