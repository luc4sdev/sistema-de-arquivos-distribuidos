export interface FileOperationResponse {
    status: 'success' | 'error';
    message?: string;
    content?: string;
    timeMs?: number;
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