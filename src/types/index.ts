export interface FileOperationResponse {
    status: 'success' | 'error';
    message?: string;
    content?: string;
    timeMs?: number;
    files?: Array<{
        name: string;
        isDirectory: boolean;
    }>;
    filename?: string;
    node?: string; // ID do nó onde a operação foi realizada
}

export interface ListFilesPayload {
    path?: string;  // Caminho relativo ao diretório base
}

export interface CopyFilePayload {
    source: string; // Caminho relativo do arquivo de origem
    destination: string; // Caminho relativo do arquivo de destino
}

export interface DownloadFilePayload {
    path: string;   // Caminho relativo do arquivo a ser baixado
    outputName?: string; // Nome opcional para o arquivo de saída
}

export interface DownloadFileWithFallbackPayload {
    remotePath: string;   // Caminho relativo do arquivo a ser baixado
    outputName?: string; // Nome opcional para o arquivo de saída
    preferredNode: string; // Nó preferencial para leitura
    replicaNodes: string[]; // Lista de nós réplicas para fallback
}

export interface CreateFilePayload {
    filename: string;
    content: string;
}

export interface ReadFilePayload {
    filename: string;
}

export interface ReadFileWithFallbackPayload {
    filename: string;
    preferredNode: string; // Nó preferencial para leitura
    replicaNodes: string[]; // Lista de nós réplicas para fallback
}

export interface WriteFilePayload {
    filename: string;
    content: string;
}

export interface DeleteFilePayload {
    filename: string;
}

export interface GetFileContentPayload {
    filename: string; // Caminho relativo do arquivo
    allowAnyNode?: boolean; // Se true, permite buscar em qualquer nó
}

export interface PerformanceMetrics {
    operation: string;
    timeMs: number;
}

export type EventType = 'CREATE' | 'DELETE' | 'UPDATE' | 'RENAME' | 'MOVE' | 'NODE_HEARTBEAT' | 'REPLICATION_REQUEST' | 'FILE_EVENT' | 'CHECKSUM_REQUEST' | 'CHECKSUM_RESPONSE' | 'NODE_JOIN';


export interface Notification {
    event_type: EventType;
    file_path: string;
    timestamp: number;
    additional_info?: string;
    file_size?: number;
    user_id?: string;
    original_path?: string;
}

export interface SubscriptionRequest {
    client_id: string;
    watch_paths: string[];
    recursive?: boolean;
    event_types?: EventType[];
}

export interface FileMetadata {
    filePath: string;
    primaryNode: string;
    replicaNodes: string[];
    version: number;
    lastUpdated: Date;
    checksum: string;
    size: number;
}

export interface ReplicationLog {
    operationId: string;
    filePath: string;
    operationType: 'CREATE' | 'UPDATE' | 'DELETE';
    sourceNode: string;
    version: number;
    timestamp: Date;
    contentChecksum?: string;
    contentSize?: number;
}

export interface NodeStatus {
    nodeId: string;
    status: 'ONLINE' | 'OFFLINE' | 'UNSTABLE';
    lastHeartbeat: Date;
    storageCapacity: number;
    storageUsed: number;
}

export interface ReplicationRequest {
    filePath: string;
    sourceNode: string;
    targetNodes: string[];
    content?: Buffer;
    operation: 'CREATE' | 'UPDATE' | 'DELETE';
    version: number;
    checksum: string;
}