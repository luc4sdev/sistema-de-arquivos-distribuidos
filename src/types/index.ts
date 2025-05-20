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

export interface CreateFilePayload {
    filename: string;
    content: string;
}

export interface ReadFilePayload {
    filename: string;
}

export interface WriteFilePayload {
    filename: string;
    content: string;
}

export interface DeleteFilePayload {
    filename: string;
}

export interface PerformanceMetrics {
    operation: string;
    timeMs: number;
}

export type EventType = 'CREATE' | 'DELETE' | 'MODIFY' | 'RENAME' | 'MOVE';

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

