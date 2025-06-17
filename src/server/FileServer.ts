import { promises as fs } from 'fs';
import path from 'path';
import {
    FileOperationResponse,
    CreateFilePayload,
    ReadFilePayload,
    WriteFilePayload,
    DeleteFilePayload,
    ListFilesPayload,
    DownloadFilePayload,
    CopyFilePayload,
    ReadFileWithFallbackPayload,
    DownloadFileWithFallbackPayload,
    GetFileContentPayload
} from '../types';
import { MetadataService } from './metadataService';
import { ReplicationService } from './replicationService';

export class FileServer {
    constructor(
        private metadataService: MetadataService,
        private replicationService: ReplicationService,
        private storageBasePath: string = './nodes'
    ) {
        // Garante que o diretório base existe
        fs.mkdir(this.storageBasePath, { recursive: true }).catch(console.error);
    }

    private getNodePath(nodeId: string, filePath: string): string {
        return path.join(this.storageBasePath, nodeId, filePath);
    }

    async listFiles({ path: filePath = '', nodeId }: ListFilesPayload & { nodeId?: string }): Promise<FileOperationResponse> {
        try {
            const targetNode = nodeId || this.replicationService.currentNodeId;
            const fullPath = this.getNodePath(targetNode, filePath);

            const files = await fs.readdir(fullPath);

            const filesWithInfo = await Promise.all(
                files.map(async file => {
                    const nodePath = path.join(fullPath, file);
                    return {
                        name: file,
                        isDirectory: await this.isDirectory(nodePath)
                    };
                })
            );

            return {
                status: 'success',
                files: filesWithInfo,
                node: targetNode
            };
        } catch (err) {
            return {
                status: 'error',
                message: `Erro ao listar arquivos: ${(err as Error).message}`
            };
        }
    }

    async copyFile({ source, destination }: CopyFilePayload): Promise<FileOperationResponse> {
        try {
            const sourcePath = this.getNodePath(this.replicationService.currentNodeId, source);
            const destPath = this.getNodePath(this.replicationService.currentNodeId, destination);

            await fs.mkdir(path.dirname(destPath), { recursive: true });
            await fs.copyFile(sourcePath, destPath);

            return { status: 'success' };
        } catch (err) {
            return {
                status: 'error',
                message: `Erro ao copiar arquivo: ${(err as Error).message}`
            };
        }
    }

    async downloadFileWithFallback({
        remotePath,
        outputName,
        preferredNode,
        replicaNodes
    }: DownloadFileWithFallbackPayload): Promise<FileOperationResponse> {
        try {
            let content: Buffer | null = null;
            let lastError: Error | null = null;

            // Tenta primeiro no nó preferencial
            try {
                const preferredPath = this.getNodePath(preferredNode, remotePath);
                content = await fs.readFile(preferredPath);
            } catch (err) {
                lastError = err as Error;
            }

            // Se falhar, tenta nas réplicas
            if (!content) {
                for (const node of replicaNodes) {
                    try {
                        const nodePath = this.getNodePath(node, remotePath);
                        content = await fs.readFile(nodePath);
                        if (content) break;
                    } catch (err) {
                        lastError = err as Error;
                        continue;
                    }
                }
            }

            if (!content) {
                throw lastError || new Error('Arquivo não encontrado em nenhum nó');
            }

            return {
                status: 'success',
                filename: outputName || path.basename(remotePath),
                content: content.toString('base64'),
                node: content ? preferredNode : undefined
            };
        } catch (err) {
            return {
                status: 'error',
                message: `Erro ao baixar arquivo: ${(err as Error).message}`
            };
        }
    }

    async readFileWithFallback({
        filename,
        preferredNode,
        replicaNodes
    }: ReadFileWithFallbackPayload): Promise<FileOperationResponse> {
        try {
            let content: string | null = null;
            let lastError: Error | null = null;

            // Tenta primeiro no nó preferencial
            try {
                const preferredPath = this.getNodePath(preferredNode, filename);
                content = await fs.readFile(preferredPath, 'utf-8');
            } catch (err) {
                lastError = err as Error;
            }

            // Se falhar, tenta nas réplicas
            if (!content) {
                for (const node of replicaNodes) {
                    try {
                        const nodePath = this.getNodePath(node, filename);
                        content = await fs.readFile(nodePath, 'utf-8');
                        if (content) break;
                    } catch (err) {
                        lastError = err as Error;
                        continue;
                    }
                }
            }

            if (!content) {
                throw lastError || new Error('Arquivo não encontrado em nenhum nó');
            }

            return {
                status: 'success',
                content,
                node: content ? preferredNode : undefined
            };
        } catch (err) {
            return {
                status: 'error',
                message: `Erro ao ler arquivo: ${(err as Error).message}`
            };
        }
    }

    async getFileContent({
        filename,
        allowAnyNode = false
    }: GetFileContentPayload): Promise<string> {
        if (allowAnyNode) {
            const metadata = this.metadataService.getFileMetadata(filename);
            if (!metadata) {
                throw new Error('Arquivo não encontrado nos metadados');
            }

            // Tenta primeiro no primário
            try {
                const primaryPath = this.getNodePath(metadata.primaryNode, filename);
                return await fs.readFile(primaryPath, 'utf-8');
            } catch (err) {
                // Se falhar, tenta nas réplicas
                for (const node of metadata.replicaNodes) {
                    try {
                        const nodePath = this.getNodePath(node, filename);
                        return await fs.readFile(nodePath, 'utf-8');
                    } catch {
                        continue;
                    }
                }
                throw new Error('Não foi possível ler o arquivo em nenhum nó');
            }
        } else {
            const localPath = this.getNodePath(this.replicationService.currentNodeId, filename);
            return await fs.readFile(localPath, 'utf-8');
        }
    }

    private async isDirectory(path: string): Promise<boolean> {
        try {
            const stat = await fs.stat(path);
            return stat.isDirectory();
        } catch {
            return false;
        }
    }

    async createFile({ filename, content }: CreateFilePayload): Promise<FileOperationResponse> {
        try {
            const fullPath = this.getNodePath(this.replicationService.currentNodeId, filename);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, content);
            return { status: 'success' };
        } catch (err) {
            return {
                status: 'error',
                message: `Erro ao criar arquivo: ${(err as Error).message}`
            };
        }
    }

    async readFile({ filename }: ReadFilePayload): Promise<FileOperationResponse> {
        try {
            const localPath = this.getNodePath(this.replicationService.currentNodeId, filename);
            const content = await fs.readFile(localPath, 'utf-8');
            return { status: 'success', content };
        } catch (err) {
            return {
                status: 'error',
                message: `Erro ao ler arquivo: ${(err as Error).message}`
            };
        }
    }

    async writeFile({ filename, content }: WriteFilePayload): Promise<FileOperationResponse> {
        try {
            const fullPath = this.getNodePath(this.replicationService.currentNodeId, filename);
            await fs.writeFile(fullPath, content);
            return { status: 'success' };
        } catch (err) {
            return {
                status: 'error',
                message: `Erro ao escrever no arquivo: ${(err as Error).message}`
            };
        }
    }

    async deleteFile({ filename }: DeleteFilePayload): Promise<FileOperationResponse> {
        try {
            const fullPath = this.getNodePath(this.replicationService.currentNodeId, filename);
            await fs.unlink(fullPath);
            return { status: 'success' };
        } catch (err) {
            return {
                status: 'error',
                message: `Erro ao deletar arquivo: ${(err as Error).message}`
            };
        }
    }
}