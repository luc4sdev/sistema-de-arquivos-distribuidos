import { FileMetadata, NodeStatus } from '../types';
import { RedisClientType } from 'redis';

const REPLICATION_FACTOR = 2;
const NODE_HASH = 'node_status';

export class MetadataService {
    private fileMetadata: Map<string, FileMetadata> = new Map();
    private nodeStatus = new Map<string, NodeStatus>();
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

        // Limpa cache local antes de repopular
        this.fileMetadata.clear();

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

    public async getNodeStatus(id: string): Promise<NodeStatus | undefined> {
        const raw = await this.redis.hGet('node_status', id);
        if (!raw) return undefined;

        try {
            return JSON.parse(raw) as NodeStatus;
        } catch (err) {
            console.error(`[MetadataService] Erro ao parsear status do nó ${id}:`, err);
            return undefined;
        }
    }


    public registerNode(id: string, status: NodeStatus) {
        if (!this.nodeStatus.has(id)) {
            this.nodeStatus.set(id, status);
            void this.redis.hSet(NODE_HASH, { [id]: JSON.stringify(status) });
        }
    }

    public updateNodeStatus(id: string, status: NodeStatus) {
        this.nodeStatus.set(id, status);
        void this.redis.hSet(NODE_HASH, { [id]: JSON.stringify(status) });
    }
    public getAvailableNodes(): string[] {
        return [...this.nodeStatus]
            .filter(([, st]) => st.status === 'ONLINE')
            .map(([id]) => id);
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
        const obj: Record<string, NodeStatus> = {};
        for (const [id, st] of this.nodeStatus) obj[id] = st;
        return obj;
    }

    public async loadAllFromRedis(): Promise<void> {

        /* nós -------------------------------------------------------------- */
        const nodes = await this.redis.hGetAll(NODE_HASH);
        for (const [id, raw] of Object.entries(nodes)) {
            try {
                this.nodeStatus.set(id, JSON.parse(raw as string));
            } catch (e) {
                console.error(`[MetadataService] Falha ao parsear node ${id}`, e);
            }
        }

        console.log(
            `[MetadataService] Cache populado: ` +
            `${this.fileMetadata.size} arquivos | ${this.nodeStatus.size} nós`
        );
    }

    public async listAllFilesFromMetadata(): Promise<{ status: string; files: string[] }> {
        await this.loadAllMetadataFromRedis(); // garante que está atualizado

        const files = this.getAllFiles(); // caminhos dos arquivos

        return {
            status: 'success',
            files
        };
    }

    public async clearAllMetadata(): Promise<void> {
        try {
            this.fileMetadata.clear();

            await this.redis.del('file_metadata');

            console.log('[MetadataService] Todos os metadados foram apagados.');
        } catch (err) {
            console.error('[MetadataService] Falha ao limpar metadados:', err);
            throw err;
        }
    }


}
