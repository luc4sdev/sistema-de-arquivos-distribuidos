import { promises as fs } from 'fs';
import crypto from 'crypto';
import path from 'path';
import { MetadataService } from './metadataService';
import { ReplicationService } from './replicationService';
import { FileOperationResponse, FileChunkData } from '../types';

export class FileServer {
    private chunkBuffers = new Map<string, {
        chunks: Buffer[];
        totalChunks: number;
        checksums: string[];
    }>();

    constructor(
        private metadataService: MetadataService,
        private replicationService: ReplicationService,
        private storageBasePath: string = './nodes'
    ) {
        this.ensureBaseDirectory();
    }

    private async ensureBaseDirectory(): Promise<void> {
        try {
            await fs.mkdir(this.storageBasePath, { recursive: true });
        } catch (err) {
            console.error('Erro ao criar diretório base:', err);
        }
    }

    private getNodePath(nodeId: string, filePath: string): string {
        return path.join(this.storageBasePath, nodeId, filePath);
    }

    public async createFile(filename: string, content: string): Promise<FileOperationResponse> {
        try {
            const fullPath = this.getNodePath(this.replicationService.currentNodeId, filename);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, content);

            return {
                status: 'success',
                message: 'Arquivo criado com sucesso'
            };
        } catch (err) {
            console.error(`Erro ao criar arquivo ${filename}:`, err);
            return {
                status: 'error',
                message: `Falha ao criar arquivo: ${(err as Error).message}`
            };
        }
    }

    public async writeFile(filename: string, content: string): Promise<FileOperationResponse> {
        try {
            const fullPath = this.getNodePath(this.replicationService.currentNodeId, filename);
            await fs.writeFile(fullPath, content);

            return {
                status: 'success',
                message: 'Arquivo atualizado com sucesso'
            };
        } catch (err) {
            console.error(`Erro ao atualizar arquivo ${filename}:`, err);
            return {
                status: 'error',
                message: `Falha ao atualizar arquivo: ${(err as Error).message}`
            };
        }
    }

    public async deleteFile(filename: string): Promise<FileOperationResponse> {
        try {
            const fullPath = this.getNodePath(this.replicationService.currentNodeId, filename);

            // 1. Tenta deletar arquivo completo (se existir)
            try {
                await fs.unlink(fullPath);
            } catch (err) {
                console.error(`Arquivo completo não encontrado, deletando chunks... ${filename}:`, err);
            }

            // 2. Deleta chunks (se existirem)
            await this.deleteAllChunks(filename);

            return {
                status: 'success',
                message: 'Arquivo removido com sucesso'
            };
        } catch (err) {
            console.error(`Erro ao deletar ${filename}:`, err);
            return {
                status: 'error',
                message: `Falha ao deletar arquivo: ${(err as Error).message}`
            };
        }
    }

    private async deleteAllChunks(filename: string): Promise<void> {
        const nodePath = this.getNodePath(this.replicationService.currentNodeId, '');

        try {
            const files = await fs.readdir(nodePath);
            const chunkFiles = files.filter(file => file.startsWith(`${filename}.chunk`));

            await Promise.all(
                chunkFiles.map(file =>
                    fs.unlink(path.join(nodePath, file)).catch(err => {
                        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                            console.error(`Erro ao deletar chunk ${file}:`, err);
                        }
                    })
                )
            );
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw err;
            }
        }
    }

    public async readFile(filename: string): Promise<FileOperationResponse> {
        try {
            const fullPath = this.getNodePath(this.replicationService.currentNodeId, filename);
            const content = await fs.readFile(fullPath, 'utf-8');

            return {
                status: 'success',
                content,
                message: 'Arquivo lido com sucesso'
            };
        } catch (err) {
            console.error(`Erro ao ler arquivo ${filename}:`, err);
            return {
                status: 'error',
                message: `Falha ao ler arquivo: ${(err as Error).message}`
            };
        }
    }

    public async readFileWithFallback(filename: string, preferredNode: string, replicaNodes: string[]): Promise<FileOperationResponse> {
        try {
            // Tenta primeiro no nó preferencial
            try {
                const response = await this.readFromNode(filename, preferredNode);
                if (response.status === 'success') {
                    return { ...response, node: preferredNode };
                }
            } catch (err) {
                console.warn(`Falha ao ler do nó preferencial ${preferredNode}:`, err);
            }

            // Tenta nas réplicas
            for (const node of replicaNodes) {
                try {
                    const response = await this.readFromNode(filename, node);
                    if (response.status === 'success') {
                        return { ...response, node };
                    }
                } catch (err) {
                    console.warn(`Falha ao ler da réplica ${node}:`, err);
                    continue;
                }
            }

            throw new Error('Arquivo não encontrado em nenhum nó disponível');
        } catch (err) {
            console.error(`Erro ao ler arquivo ${filename} com fallback:`, err);
            return {
                status: 'error',
                message: `Falha ao ler arquivo: ${(err as Error).message}`
            };
        }
    }

    private async readFromNode(filename: string, nodeId: string): Promise<FileOperationResponse> {
        try {
            const fullPath = this.getNodePath(nodeId, filename);
            const content = await fs.readFile(fullPath, 'utf-8');

            return {
                status: 'success',
                content,
                message: 'Arquivo lido com sucesso'
            };
        } catch (err) {
            throw err;
        }
    }

    public async handleFileChunk(chunkData: FileChunkData): Promise<FileOperationResponse> {
        try {
            // Valida checksum
            const calculatedChecksum = crypto.createHash('sha256')
                .update(chunkData.chunk)
                .digest('hex');

            if (calculatedChecksum !== chunkData.checksum) {
                throw new Error(`Checksum inválido para chunk ${chunkData.chunkNumber}`);
            }

            // Armazena chunk temporariamente
            if (!this.chunkBuffers.has(chunkData.filename)) {
                this.chunkBuffers.set(chunkData.filename, {
                    chunks: Array(chunkData.totalChunks),
                    totalChunks: chunkData.totalChunks,
                    checksums: []
                });
            }

            const fileData = this.chunkBuffers.get(chunkData.filename)!;
            fileData.chunks[chunkData.chunkNumber] = chunkData.chunk;
            fileData.checksums.push(chunkData.checksum);

            // Se todos os chunks foram recebidos, monta o arquivo
            if (fileData.chunks.every(chunk => chunk !== undefined)) {
                const fullContent = Buffer.concat(fileData.chunks);
                const fullPath = this.getNodePath(this.replicationService.currentNodeId, chunkData.filename);

                await fs.mkdir(path.dirname(fullPath), { recursive: true });
                await fs.writeFile(fullPath, fullContent);

                this.chunkBuffers.delete(chunkData.filename);

                return {
                    status: 'success',
                    message: `Chunk ${chunkData.chunkNumber + 1}/${chunkData.totalChunks} processado`
                };
            }

            return {
                status: 'success',
                message: `Chunk ${chunkData.chunkNumber + 1}/${chunkData.totalChunks} recebido`
            };
        } catch (err) {
            console.error(`Erro ao processar chunk ${chunkData.chunkNumber} de ${chunkData.filename}:`, err);
            return {
                status: 'error',
                message: `Falha ao processar chunk: ${(err as Error).message}`
            };
        }
    }

    public async listFiles(directoryPath: string = ''): Promise<FileOperationResponse> {
        try {
            const fullPath = this.getNodePath(this.replicationService.currentNodeId, directoryPath);
            const files = await fs.readdir(fullPath);

            const filesWithStats = await Promise.all(
                files.map(async file => {
                    const filePath = path.join(fullPath, file);
                    const stats = await fs.stat(filePath);
                    return {
                        name: file,
                        isDirectory: stats.isDirectory(),
                        size: stats.size,
                        modified: stats.mtime
                    };
                })
            );

            return {
                status: 'success',
                files: filesWithStats,
                message: 'Listagem obtida com sucesso'
            };
        } catch (err) {
            console.error(`Erro ao listar arquivos em ${directoryPath}:`, err);
            return {
                status: 'error',
                message: `Falha ao listar arquivos: ${(err as Error).message}`
            };
        }
    }

    public async getFileChecksum(filename: string): Promise<string> {
        try {
            const fullPath = this.getNodePath(this.replicationService.currentNodeId, filename);
            const content = await fs.readFile(fullPath);
            return crypto.createHash('sha256').update(content).digest('hex');
        } catch (err) {
            console.error(`Erro ao calcular checksum de ${filename}:`, err);
            throw err;
        }
    }
}