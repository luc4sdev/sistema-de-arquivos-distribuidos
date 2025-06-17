import { FileMetadata, NodeStatus } from '../types';

export class MetadataService {
    private fileMetadata: Map<string, FileMetadata> = new Map();
    private nodeStatus: Map<string, NodeStatus> = new Map();

    public getAllFiles(): string[] {
        return Array.from(this.fileMetadata.keys());
    }

    public getFileMetadata(filePath: string): FileMetadata | undefined {
        return this.fileMetadata.get(filePath);
    }

    public registerFile(filePath: string, primaryNode: string, replicaNodes: string[] = []) {
        const existing = this.fileMetadata.get(filePath);
        this.fileMetadata.set(filePath, {
            filePath,
            primaryNode,
            replicaNodes,
            version: existing ? existing.version + 1 : 1,
            lastUpdated: new Date(),
            checksum: '',
            size: 0
        });
    }

    public updateFileMetadata(filePath: string, updates: Partial<FileMetadata>) {
        const existing = this.fileMetadata.get(filePath);
        if (existing) {
            this.fileMetadata.set(filePath, { ...existing, ...updates });
        }
    }

    public promoteReplicaToPrimary(filePath: string, newPrimary: string) {
        const metadata = this.fileMetadata.get(filePath);
        if (!metadata) return;

        const updatedReplicas = metadata.replicaNodes.filter(node => node !== newPrimary);
        if (this.nodeStatus.get(metadata.primaryNode)?.status === 'ONLINE') {
            updatedReplicas.push(metadata.primaryNode);
        }

        this.fileMetadata.set(filePath, {
            ...metadata,
            primaryNode: newPrimary,
            replicaNodes: updatedReplicas,
            version: metadata.version + 1
        });
    }

    public updateNodeStatus(nodeId: string, status: NodeStatus) {
        this.nodeStatus.set(nodeId, status);
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

    public getNodeStatus(nodeId: string): NodeStatus | undefined {
        return this.nodeStatus.get(nodeId);
    }

    public registerNode(nodeId: string, initialStatus: NodeStatus) {
        if (!this.nodeStatus.has(nodeId)) {
            this.nodeStatus.set(nodeId, initialStatus);
        }
    }
}

const REPLICATION_FACTOR = 2;