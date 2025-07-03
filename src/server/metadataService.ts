import type { FileMetadata, NodeStatus } from '../types';
import type { RedisClientType } from 'redis';

const REPLICATION_FACTOR = 1;
const FILE_HASH = 'file_metadata';
const NODE_HASH = 'node_status';

export class MetadataService {
    private fileMetadata = new Map<string, FileMetadata>();   // cache de arquivos
    private nodeStatus = new Map<string, NodeStatus>();     // cache de nós

    constructor(private redis: RedisClientType) { }

    /* ------------------------------------------------------------------ */
    /* ARQUIVOS                                                            */
    /* ------------------------------------------------------------------ */
    public getAllFiles(): string[] { return [...this.fileMetadata.keys()]; }
    public getFileMetadata(path: string) { return this.fileMetadata.get(path); }


    public async registerFile(
        filePath: string,
        primaryNode: string,
        replicaNodes: string[] = [],
        chunkDistribution?: Record<number, string[]>
    ) {
        const meta: FileMetadata = {
            filePath,
            primaryNode,
            replicaNodes,
            version: 1,
            lastUpdated: new Date(),
            checksum: '',
            size: 0,
            chunkDistribution // Novo campo para rastrear chunks
        };
        this.fileMetadata.set(filePath, meta);
        await this.redis.hSet(FILE_HASH, filePath, JSON.stringify(meta));
    }

    public getChunkLocation(filename: string, chunkNumber: number): string[] | undefined {
        const meta = this.fileMetadata.get(filename);
        return meta?.chunkDistribution?.[chunkNumber];
    }

    public async updateFileMetadata(filePath: string, updates: Partial<FileMetadata>) {
        const existing = this.fileMetadata.get(filePath);
        if (!existing) return;

        const merged = { ...existing, ...updates } as FileMetadata;
        this.fileMetadata.set(filePath, merged);
        await this.redis.hSet(FILE_HASH, filePath, JSON.stringify(merged));
    }

    public async deleteFileMetadata(filePath: string) {
        this.fileMetadata.delete(filePath);
        await this.redis.hDel(FILE_HASH, filePath);
        console.log(`[MetadataService] metadado removido: ${filePath}`);
    }

    /** (Re)popula o cache local de metadados de arquivo */
    public async loadAllMetadataFromRedis() {
        const raw = await this.redis.hGetAll(FILE_HASH);
        this.fileMetadata.clear();

        for (const [fp, val] of Object.entries(raw)) {
            try { this.fileMetadata.set(fp, JSON.parse(val as string)); }
            catch (e) { console.error('[MetadataService] erro parse meta', fp, e); }
        }
        console.log(`[MetadataService] cache arquivos: ${this.fileMetadata.size}`);
    }

    /* ------------------------------------------------------------------ */
    /* NÓS                                                                 */
    /* ------------------------------------------------------------------ */

    /** Versão assíncrona (consulta cache; se forceRefresh => Redis) */
    public async getNodeStatus(id: string, forceRefresh = false): Promise<NodeStatus | undefined> {
        if (!forceRefresh) {
            const cached = this.nodeStatus.get(id);
            if (cached) return cached;
        }
        const raw = await this.redis.hGet(NODE_HASH, id);
        if (!raw) return;

        try {
            const parsed = JSON.parse(raw) as NodeStatus;
            this.nodeStatus.set(id, parsed);
            return parsed;
        } catch (e) {
            console.error('[MetadataService] parse node status', id, e);
        }
    }

    /** Versão síncrona para consultas rápidas */
    public getNodeStatusSync(id: string) { return this.nodeStatus.get(id); }

    public registerNode(id: string, st: NodeStatus) {
        this.nodeStatus.set(id, st);
        void this.redis.hSet(NODE_HASH, { [id]: JSON.stringify(st) });
    }

    public updateNodeStatus(id: string, st: NodeStatus) {
        this.nodeStatus.set(id, st);
        void this.redis.hSet(NODE_HASH, { [id]: JSON.stringify(st) });
    }

    public getAvailableNodes(): string[] {
        return [...this.nodeStatus]
            .filter(([, v]) => v.status === 'ONLINE')
            .map(([id]) => id);
    }

    public findNewReplicaCandidates(exclude: string[] = []) {
        return this.getAvailableNodes()
            .filter(n => !exclude.includes(n))
            .slice(0, REPLICATION_FACTOR);
    }

    public promoteReplicaToPrimary(filePath: string, newPrimary: string) {
        const meta = this.fileMetadata.get(filePath);
        if (!meta) return;

        const replicas = meta.replicaNodes.filter(n => n !== newPrimary);
        replicas.push(meta.primaryNode);          // antigo primário vira réplica

        const updated: FileMetadata = {
            ...meta,
            primaryNode: newPrimary,
            replicaNodes: replicas,
            version: meta.version + 1,
            lastUpdated: new Date()
        };
        this.fileMetadata.set(filePath, updated);
        void this.redis.hSet(FILE_HASH, filePath, JSON.stringify(updated));
    }

    /* ------------------------------------------------------------------ */
    /* UTIL                                                                */
    /* ------------------------------------------------------------------ */

    /** Hydrata caches de arquivo + nós em um único round‑trip */
    public async loadAllFromRedis() {
        await Promise.all([this.loadAllMetadataFromRedis(), this.reloadNodesFromRedis()]);
    }

    private async reloadNodesFromRedis() {
        const raw = await this.redis.hGetAll(NODE_HASH);
        this.nodeStatus.clear();
        for (const [id, val] of Object.entries(raw)) {
            try { this.nodeStatus.set(id, JSON.parse(val as string)); }
            catch (e) { console.error('[MetadataService] parse node', id, e); }
        }
        console.log(`[MetadataService] cache nós: ${this.nodeStatus.size}`);
    }

    /** Lista de arquivos apenas via metadados (sem tocar nos nós) */
    public async listAllFilesFromMetadata() {
        await this.loadAllMetadataFromRedis();
        return { status: 'success', files: this.getAllFiles() };
    }

    /** Utilidade para testes: zera tudo */
    public async clearAllMetadata() {
        this.fileMetadata.clear();
        await this.redis.del(FILE_HASH);
        await this.redis.del(NODE_HASH);
        console.log('[MetadataService] metadados zerados');
    }
}
