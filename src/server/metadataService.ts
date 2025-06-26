import { FileMetadata, NodeStatus } from '../types';
import { RedisClientType } from 'redis';

const REPLICATION_FACTOR = 2;

export class MetadataService {
    private fileMetadata: Map<string, FileMetadata> = new Map();
    private nodeStatus: Map<string, NodeStatus> = new Map();
    private redis: RedisClientType;

    constructor(redisClient: RedisClientType) {
        this.redis = redisClient;
    }

    // ----- ARQUIVOS -----

    public getAllFiles(): string[] {
        return Array.from(this.fileMetadata.keys());
    }

    public getFileMetadata(filePath: string): FileMetadata | undefined {
        return this.fileMetadata.get(filePath);
    }

    public async registerFile(filePath: string, primaryNode: string, replicaNodes: string[] = []) {
        const existing = this.fileMetadata.get(filePath);
        const metadata: FileMetadata = {
            filePath,
            primaryNode,
            replicaNodes,
            version: existing ? existing.version + 1 : 1,
            lastUpdated: new Date(),
            checksum: '',
            size: 0
        };
        this.fileMetadata.set(filePath, metadata);
        await this.redis.hSet('file_metadata', filePath, JSON.stringify(metadata));
    }

    public async updateFileMetadata(filePath: string, updates: Partial<FileMetadata>) {
        const existing = this.fileMetadata.get(filePath);
        if (!existing) return;

        const updated: FileMetadata = { ...existing, ...updates };
        this.fileMetadata.set(filePath, updated);
        await this.redis.hSet('file_metadata', filePath, JSON.stringify(updated));
    }

    public async deleteFileMetadata(filePath: string) {
        this.fileMetadata.delete(filePath);
        await this.redis.hDel('file_metadata', filePath);
        console.log(`[MetadataService] Metadado deletado para o arquivo ${filePath}`);
    }

    public async loadAllMetadataFromRedis() {
        const all = await this.redis.hGetAll('file_metadata');

        for (const [filePath, value] of Object.entries(all)) {
            const strValue = typeof value === 'string' ? value : String(value);
            try {
                const parsed: FileMetadata = JSON.parse(strValue);
                this.fileMetadata.set(filePath, parsed);
            } catch (err) {
                console.error(`Erro ao carregar metadado do arquivo ${filePath}:`, err);
            }
        }

        console.log(`[MetadataService] Metadados carregados do Redis: ${this.fileMetadata.size} arquivos.`);
    }

    // ----- NÓS -----

    public registerNode(nodeId: string, initialStatus: NodeStatus) {
        if (!this.nodeStatus.has(nodeId)) {
            this.nodeStatus.set(nodeId, initialStatus);
        }
    }

    public updateNodeStatus(nodeId: string, status: NodeStatus) {
        this.nodeStatus.set(nodeId, status);
    }

    public getNodeStatus(nodeId: string): NodeStatus | undefined {
        return this.nodeStatus.get(nodeId);
    }

    public getAvailableNodes(): string[] {
        return Array.from(this.nodeStatus.entries())
            .filter(([_, status]) => status.status === 'ONLINE')
            .map(([nodeId]) => nodeId);
    }

    public findNewReplicaCandidates(excludeNodes: string[] = []): string[] {
        return this.getAvailableNodes()
            .filter(nodeId => !excludeNodes.includes(nodeId))
            .slice(0, REPLICATION_FACTOR);
    }

    public promoteReplicaToPrimary(filePath: string, newPrimary: string) {
        const metadata = this.fileMetadata.get(filePath);
        if (!metadata) return;

        const updatedReplicas = metadata.replicaNodes.filter(n => n !== newPrimary);
        if (this.nodeStatus.get(metadata.primaryNode)?.status === 'ONLINE') {
            updatedReplicas.push(metadata.primaryNode);
        }

        const updatedMetadata: FileMetadata = {
            ...metadata,
            primaryNode: newPrimary,
            replicaNodes: updatedReplicas,
            version: metadata.version + 1
        };

        this.fileMetadata.set(filePath, updatedMetadata);
        this.redis.hSet('file_metadata', filePath, JSON.stringify(updatedMetadata));
    }

    public getAllNodes(): Record<string, NodeStatus> {
        const result: Record<string, NodeStatus> = {};
        for (const [nodeId, status] of this.nodeStatus.entries()) {
            result[nodeId] = status;
        }
        return result;
    }

}
