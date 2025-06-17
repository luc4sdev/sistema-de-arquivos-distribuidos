import { RedisPubSub } from '../redis/RedisPubSub';
import { MetadataService } from './metadataService';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import path, { join } from 'path';
import { Notification } from '../types';
import * as crypto from 'crypto';

const INTEGRITY_CHECK_INTERVAL = 30000;
const HEARTBEAT_INTERVAL = 5000;
const REPLICATION_TIMEOUT = 10000; // 10 seconds

export class ReplicationService {
  private healthyNodes: Set<string> = new Set();
  public currentNodeId: string;
  private storagePath: string;

  constructor(
    private metadataService: MetadataService,
    private pubSub: RedisPubSub,
    nodeId: string,
    storagePath: string = './nodes'
  ) {
    this.currentNodeId = nodeId;
    this.storagePath = storagePath;
    this.setupSubscriptions();
    this.startHeartbeat();
    this.startIntegrityChecks();
  }

  public async initialize() {
    this.metadataService.registerNode(this.currentNodeId, {
      nodeId: this.currentNodeId,
      status: 'ONLINE',
      lastHeartbeat: new Date(),
      storageCapacity: this.getStorageCapacity(),
      storageUsed: this.getStorageUsed()
    });
  }

  private setupSubscriptions() {
    this.pubSub.subscribe('node_status', (msg: Notification) => {
      if (msg.event_type === 'NODE_HEARTBEAT') {
        const status = JSON.parse(msg.additional_info as string);
        this.updateNodeStatus(status);
      }
    });

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

  }

  private startHeartbeat() {
    setInterval(() => {
      const status = {
        nodeId: this.currentNodeId,
        status: 'ONLINE',
        lastHeartbeat: new Date(),
        storageCapacity: this.getStorageCapacity(),
        storageUsed: this.getStorageUsed()
      };
      this.pubSub.publish('node_status', {
        event_type: 'NODE_HEARTBEAT',
        file_path: '',
        timestamp: Date.now(),
        additional_info: JSON.stringify(status)
      });
    }, HEARTBEAT_INTERVAL);
  }

  private startIntegrityChecks() {
    setInterval(() => {
      this.verifyReplicaIntegrity().catch(console.error);
    }, INTEGRITY_CHECK_INTERVAL);
  }

  private updateNodeStatus(status: any) {
    this.metadataService.updateNodeStatus(status.nodeId, status);
    if (status.status === 'ONLINE') {
      this.healthyNodes.add(status.nodeId);
    } else {
      this.healthyNodes.delete(status.nodeId);
    }
  }

  private async verifyReplicaIntegrity() {
    const files = this.metadataService.getAllFiles();

    for (const file of files) {
      const metadata = this.metadataService.getFileMetadata(file);
      if (!metadata || metadata.primaryNode !== this.currentNodeId) continue;

      const primaryPath = this.getFilePath(file);
      if (!existsSync(primaryPath)) continue;

      const primaryChecksum = this.calculateChecksum(primaryPath);

      for (const replicaNode of metadata.replicaNodes) {
        if (!this.healthyNodes.has(replicaNode)) continue;

        try {
          const replicaChecksum = await this.requestChecksum(replicaNode, file);
          if (replicaChecksum !== primaryChecksum) {
            await this.replicateToNode(file, replicaNode);
          }
        } catch (err) {
          console.error(`Falha ao verificar réplica ${replicaNode}:`, err);
        }
      }
    }
  }

  public async replicateFileOperation(
    filePath: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    content?: string
  ): Promise<{ newVersion: number, checksum: string }> {
    const metadata = this.metadataService.getFileMetadata(filePath);
    if (!metadata) {
      throw new Error(`Metadados não encontrados para ${filePath}`);
    }

    if (metadata.primaryNode !== this.currentNodeId) {
      throw new Error(`Operação deve ser encaminhada ao nó primário (${metadata.primaryNode})`);
    }

    await this.processLocalOperation(filePath, operation, content);

    const newVersion = metadata.version + 1;
    const checksum = content ? this.calculateChecksumFromString(content) : '';

    this.metadataService.updateFileMetadata(filePath, {
      version: newVersion,
      checksum,
      lastUpdated: new Date(),
      size: operation === 'DELETE' ? 0 : content?.length || 0
    });

    await this.sendToReplicas(filePath, operation, content || '', newVersion, checksum);

    return { newVersion, checksum };
  }

  private async processLocalOperation(
    filePath: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    content?: string
  ) {
    const fullPath = this.getFilePath(filePath);

    try {
      switch (operation) {
        case 'CREATE':
        case 'UPDATE':
          if (!content) throw new Error('Conteúdo necessário');
          mkdirSync(path.dirname(fullPath), { recursive: true });
          writeFileSync(fullPath, content);
          break;
        case 'DELETE':
          if (existsSync(fullPath)) unlinkSync(fullPath);
          break;
      }
    } catch (err) {
      console.error(`Falha ao processar operação ${operation} para ${filePath}:`, err);
      throw err;
    }
  }

  private async sendToReplicas(
    filePath: string,
    operation: 'CREATE' | 'UPDATE' | 'DELETE',
    content: string,
    version: number,
    checksum: string
  ) {
    const metadata = this.metadataService.getFileMetadata(filePath);
    if (!metadata) return;

    const healthyReplicas = metadata.replicaNodes.filter(node =>
      this.healthyNodes.has(node) && node !== this.currentNodeId
    );

    if (healthyReplicas.length === 0) {
      console.warn(`Nenhuma réplica saudável disponível para ${filePath}`);
      return;
    }

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
        targetNodes: healthyReplicas
      })
    });
  }

  private async handleReplicationRequest(msg: Notification) {
    const { operation, content, version, checksum, sourceNode, targetNodes } =
      JSON.parse(msg.additional_info as string);
    console.log(`Recebendo replicação: ${msg.file_path} de ${sourceNode} para ${targetNodes.join(', ')}`);
    console.log(`Operação: ${operation}, Versão: ${version}, Checksum: ${checksum}`);

    if (sourceNode === this.currentNodeId || !targetNodes.includes(this.currentNodeId)) {
      return;
    }

    const filePath = msg.file_path;
    const metadata = this.metadataService.getFileMetadata(filePath);

    if (metadata && metadata.primaryNode !== sourceNode) {
      console.warn(`Ignorando replicação inválida: ${filePath} de ${sourceNode}`);
      return;
    }


    try {
      await this.processLocalOperation(filePath, operation as any, content);

      const updates = {
        version,
        checksum,
        lastUpdated: new Date(),
        size: operation === 'DELETE' ? 0 : content.length
      };

      if (!metadata) {
        this.metadataService.registerFile(
          filePath,
          sourceNode,
          targetNodes.filter((n: string) => n !== this.currentNodeId)
        );
      }

      this.metadataService.updateFileMetadata(filePath, updates);
    } catch (err) {
      console.error(`Falha ao processar replicação para ${filePath}:`, err);
    }
  }

  private async replicateToNode(filePath: string, targetNode: string) {
    const content = readFileSync(this.getFilePath(filePath), 'utf-8');
    const checksum = this.calculateChecksumFromString(content);
    const metadata = this.metadataService.getFileMetadata(filePath);

    if (!metadata) return;

    await this.sendToReplicas(
      filePath,
      'UPDATE',
      content,
      metadata.version,
      checksum
    );
  }

  private async requestChecksum(nodeId: string, filePath: string): Promise<string> {
    if (nodeId === this.currentNodeId) {
      return this.calculateChecksum(this.getFilePath(filePath));
    }

    const requestId = crypto.randomUUID();
    const responseChannel = `checksum_responses:${requestId}`;

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pubSub.unsubscribe(responseChannel);
        reject(new Error(`Timeout ao solicitar checksum de ${nodeId} para o arquivo ${filePath}`));
      }, REPLICATION_TIMEOUT);

      // Ouve a resposta
      this.pubSub.subscribe(responseChannel, (msg: Notification) => {
        try {
          const data = JSON.parse(msg.additional_info || '{}');
          if (data.checksum) {
            clearTimeout(timeout);
            this.pubSub.unsubscribe(responseChannel);
            resolve(data.checksum);
          } else {
            throw new Error('Resposta inválida');
          }
        } catch (err) {
          clearTimeout(timeout);
          this.pubSub.unsubscribe(responseChannel);
          reject(err);
        }
      });

      // Envia o pedido
      this.pubSub.publish('checksum_requests', {
        event_type: 'CHECKSUM_REQUEST',
        file_path: filePath,
        timestamp: Date.now(),
        additional_info: JSON.stringify({
          sourceNode: this.currentNodeId,
          targetNode: nodeId,
          requestId
        })
      });
    });
  }

  private async handleChecksumRequest(msg: Notification) {
    const data = JSON.parse(msg.additional_info || '{}');

    const { sourceNode, targetNode, requestId } = data;
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

  private getFilePath(filePath: string): string {
    return join(this.storagePath, this.currentNodeId, filePath);
  }

  private calculateChecksum(filePath: string): string {
    return this.calculateChecksumFromString(readFileSync(filePath, 'utf-8'));
  }

  private calculateChecksumFromString(content: string): string {
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
}