import { RedisPubSub } from '../redis/RedisPubSub';
import { MetadataService } from './metadataService';
import { readFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { Notification } from '../types';
import * as crypto from 'crypto';
import { FileServer } from './FileServer';

const INTEGRITY_CHECK_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_INTERVAL = 5000; // 5 seconds
const REPLICATION_TIMEOUT = 10000; // 10 seconds

export class ReplicationService {
  private healthyNodes: Set<string> = new Set();
  public currentNodeId: string;
  private storagePath: string;
  private fileServer: FileServer;
  private readonly isStorageNode = process.env.IS_STORAGE_NODE !== 'false';

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
        this.metadataService.updateNodeStatus(status.nodeId, status);
        if (status.status === 'ONLINE') {
          this.healthyNodes.add(status.nodeId);
        } else {
          this.healthyNodes.delete(status.nodeId);
        }
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

    this.metadataService.updateFileMetadata(filePath, {
      version: newVersion,
      checksum,
      lastUpdated: new Date(),
      size: operation === 'DELETE' ? 0 : content?.length || 0
    });

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

      if (!this.metadataService.getFileMetadata(filePath))
        await this.metadataService.registerFile(filePath, sourceNode, []);

      await this.metadataService.updateFileMetadata(filePath, {
        version, checksum, lastUpdated: new Date(),
        size: operation === 'DELETE' ? 0 : content.length
      });
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

    const primarios = this.metadataService.getAllFiles()
      .filter(f => this.metadataService.getFileMetadata(f)?.primaryNode === this.currentNodeId);

    for (const file of primarios) {
      const meta = this.metadataService.getFileMetadata(file);
      if (!meta) continue;

      const primPath = this.getFilePath(file);
      if (!existsSync(primPath)) continue;

      const primChk = this.calculateChecksum(primPath);

      await Promise.all(
        meta.replicaNodes
          .filter(n => this.isStorageNodeId(n))
          .map(async replica => {
            try {
              const rChk = await this.requestChecksum(replica, file);
              if (rChk !== primChk)
                await this.replicateToNode(file, replica);     // corrige réplica
            } catch {
              this.healthyNodes.delete(replica);               // réplica caiu
            }
          })
      );
    }
  }


  private async syncFilesToNewNode(newNodeId: string): Promise<void> {
    if (!this.isStorageNodeId(newNodeId)) return;

    /* limpa órfãos */
    const dir = join(this.storagePath, newNodeId);
    if (existsSync(dir)) {
      for (const f of readdirSync(dir))
        if (!this.metadataService.getFileMetadata(f)) unlinkSync(join(dir, f));
    }

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