import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path, { join } from 'path';
import { FileServer } from './FileServer';
import { measureTime } from '../utils';
import { Notification, PerformanceMetrics } from '../types';
import { generateChart } from '../utils';
import { RedisPubSub } from '../redis/RedisPubSub';
import { ReplicationService } from './replicationService';
import { MetadataService } from './metadataService';
import { SubscriptionService } from '../redis/SubscriptionService';
import { readFileSync } from 'fs';
import * as crypto from 'crypto';

const PROTO_PATH = path.join(__dirname, '../proto/filesystem.proto');

export class GRPCServer {
    private server: grpc.Server;
    private fileServer: FileServer;
    private performanceMetrics: PerformanceMetrics[] = [];
    private pubSub: RedisPubSub;
    private replicationService: ReplicationService;
    private metadataService: MetadataService;

    constructor(
        private port: number = parseInt(process.env.PORT || '50050'),
        private storagePath: string = process.env.STORAGE_PATH || './nodes'
    ) {
        this.pubSub = new RedisPubSub();
        const redisClient = this.pubSub.getClient();
        this.metadataService = new MetadataService(redisClient);
        this.replicationService = new ReplicationService(
            this.metadataService,
            this.pubSub,
            this.storagePath
        );
        this.fileServer = new FileServer(this.metadataService, this.replicationService, this.storagePath);
        this.server = new grpc.Server();
        this.setupGRPC();
    }

    private setupGRPC() {
        const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
            keepCase: true,
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true
        });

        const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;

        this.server.addService(protoDescriptor.filesystem.FileSystem.service, {
            CreateFile: this.wrapWithMetrics(this.createFile.bind(this), 'create'),
            ReadFile: this.wrapWithMetrics(this.readFile.bind(this), 'read'),
            WriteFile: this.wrapWithMetrics(this.writeFile.bind(this), 'write'),
            DeleteFile: this.wrapWithMetrics(this.deleteFile.bind(this), 'delete'),
            CopyFile: this.wrapWithMetrics(this.copyFile.bind(this), 'copy'),
            DownloadFile: this.wrapWithMetrics(this.downloadFile.bind(this), 'download'),
            UploadFile: this.handleUploadFile.bind(this),
            Subscribe: this.subscribe.bind(this)
        });
    }

    private wrapWithMetrics(
        fn: (call: any, callback: any) => Promise<any>,
        operationPrefix: string
    ) {
        return async (call: any, callback: any) => {
            const { timeMs, result } = await measureTime(() => fn(call, callback));

            const operation = `${operationPrefix}_${call.request.filename || call.request.path || 'root'}`;
            this.performanceMetrics.push({ operation, timeMs });

            callback(null, { ...result, timeMs });
        };
    }

    private async createFile(call: any): Promise<any> {
        const { filename, content } = call.request;

        try {
            await this.pubSub.publish('file_operations', {
                event_type: 'FILE_OPERATION',
                file_path: filename,
                timestamp: Date.now(),
                additional_info: JSON.stringify({
                    operation: 'CREATE',
                    content,
                })
            });

            return {
                status: 'success',
            };
        } catch (err) {
            console.error(`Erro ao criar arquivo ${filename}:`, err);
            throw err;
        }
    }

    private async writeFile(call: any): Promise<any> {
        const { filename, content } = call.request;

        try {
            await this.pubSub.publish('file_operations', {
                event_type: 'FILE_OPERATION',
                file_path: filename,
                timestamp: Date.now(),
                additional_info: JSON.stringify({
                    operation: 'UPDATE',
                    content,
                })
            });

            return {
                status: 'success',
            };
        } catch (err) {
            console.error(`Erro ao atualizar arquivo ${filename}:`, err);
            throw err;
        }
    }

    private async deleteFile(call: any): Promise<any> {
        const { filename } = call.request;

        try {
            await this.pubSub.publish('file_operations', {
                event_type: 'FILE_OPERATION',
                file_path: filename,
                timestamp: Date.now(),
                additional_info: JSON.stringify({
                    operation: 'DELETE',
                })
            });

            return { status: 'success' };
        } catch (err) {
            console.error(`Erro ao deletar arquivo ${filename}:`, err);
            throw err;
        }
    }

    private async copyFile(call: any): Promise<any> {
        const { source, destination } = call.request;
        const localFilePath = join(__dirname, '..', '..', 'localFiles', source);

        try {
            // Verificar se destino já existe
            if (this.metadataService.getFileMetadata(destination)) {
                throw new Error(`Arquivo ${destination} já existe`);
            }

            const sourceContent = readFileSync(localFilePath, 'utf-8');

            // Criar cópia com replicação
            await this.pubSub.publish('file_operations', {
                event_type: 'FILE_OPERATION',
                file_path: destination,
                timestamp: Date.now(),
                additional_info: JSON.stringify({
                    operation: 'CREATE',
                    content: sourceContent,
                })
            });
            return {
                status: 'success',
            };
        } catch (err) {
            console.error(`Erro ao copiar ${source} para ${destination}:`, err);
            throw err;
        }
    }

    private async readFile(call: any): Promise<any> {
        const { filename } = call.request;
        await this.metadataService.loadAllMetadataFromRedis();
        await this.metadataService.loadAllFromRedis();

        try {
            /* 1. Metadados */
            const meta = this.metadataService.getFileMetadata(filename);
            if (!meta) throw new Error(`Arquivo ${filename} não encontrado nos metadados`);

            /* 2. Primário + réplicas           */
            const candidateNodes = [meta.primaryNode, 'node2', 'node3', 'node4'];
            console.log(meta)
            /* 3. Primeiro candidato “online”   */
            let targetNode: string | undefined = undefined;

            for (const n of candidateNodes) {
                const st = await this.metadataService.getNodeStatus(n);
                console.log(`Status do nó ${n}:`, st);

                if (st?.status === 'ONLINE') {
                    targetNode = n;
                    break;
                }
            }


            if (!targetNode) throw new Error('Nenhum nó que contém o arquivo está ONLINE');

            /* 4. Canal de resposta exclusivo   */
            const requestId = crypto.randomUUID();
            const responseChannel = `file_read_responses:${requestId}`;

            const contentPromise = new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.pubSub.unsubscribe(responseChannel).catch(console.error);
                    reject(new Error('Timeout ao ler arquivo'));
                }, 5000);

                this.pubSub.subscribe(responseChannel, (msg: Notification) => {
                    clearTimeout(timeout);
                    this.pubSub.unsubscribe(responseChannel).catch(console.error);

                    const { content, error } = JSON.parse(msg.additional_info || '{}');
                    return error ? reject(new Error(error)) : resolve(content);
                });
            });

            /* 5. Publica pedido para o nó escolhido */
            await this.pubSub.publish('file_read_requests', {
                event_type: 'FILE_READ_REQUEST',
                file_path: filename,
                timestamp: Date.now(),
                additional_info: JSON.stringify({ requestId, targetNode })
            });

            const content = await contentPromise;
            return { status: 'success', content, node: targetNode };

        } catch (err) {
            console.error(`Erro ao ler arquivo ${filename}:`, err);
            throw err;
        }
    }


    private async downloadFile(call: any): Promise<any> {
        const { path, output_name } = call.request;

        try {
            const metadata = this.metadataService.getFileMetadata(path);
            if (!metadata) {
                throw new Error(`Arquivo ${path} não encontrado`);
            }

            const result = await this.fileServer.downloadFileWithFallback({
                remotePath: path,
                outputName: output_name,
                preferredNode: metadata.primaryNode,
                replicaNodes: metadata.replicaNodes
            });

            return result;
        } catch (err) {
            console.error(`Erro ao baixar arquivo ${path}:`, err);
            throw err;
        }
    }

    private async handleUploadFile(call: grpc.ServerReadableStream<any, any>, callback: any) {
        let filename = '';
        let totalChunks = 0;
        let receivedChunks = 0;

        call.on('data', async (chunk: any) => {
            try {
                if (!filename) {
                    filename = chunk.filename;
                    totalChunks = chunk.total_chunks;
                }

                // Verificar checksum do chunk
                const calculatedChecksum = crypto.createHash('sha256')
                    .update(chunk.chunk)
                    .digest('hex');

                if (calculatedChecksum !== chunk.checksum) {
                    throw new Error(`Checksum inválido para chunk ${chunk.chunk_number}`);
                }

                receivedChunks++;
                console.log(`Enviando chunk ${chunk.chunk_number + 1}/${chunk.total_chunks} para o primário via Redis`);

                // Publica o chunk no Redis
                await this.pubSub.publish('file_chunks', {
                    event_type: 'FILE_CHUNK',
                    file_path: filename,
                    timestamp: Date.now(),
                    additional_info: JSON.stringify({
                        filename: filename,
                        chunk: Buffer.from(chunk.chunk).toString('base64'), // Serializa para string
                        chunkNumber: chunk.chunk_number,
                        totalChunks: chunk.total_chunks,
                        checksum: chunk.checksum,
                        sourceNode: this.replicationService.currentNodeId
                    })
                });

            } catch (err) {
                console.error('Erro ao processar chunk:', err);
                call.destroy(err as Error);
            }
        });

        call.on('end', async () => {
            try {
                if (receivedChunks !== totalChunks) {
                    throw new Error(`Faltam chunks. Recebidos: ${receivedChunks}, Esperados: ${totalChunks}`);
                }

                console.log(`Todos os chunks (${totalChunks}) foram enviados via Redis para o nó primário.`);

                callback(null, {
                    status: 'success',
                    message: 'Chunks enviados com sucesso para o primário via Redis'
                });
            } catch (err) {
                console.error('Erro ao finalizar envio de chunks:', err);
                callback({
                    code: grpc.status.INTERNAL,
                    message: (err as Error).message
                });
            }
        });

        call.on('error', (err) => {
            console.error('Erro no stream de upload:', err);
            callback({
                code: grpc.status.INTERNAL,
                message: 'Erro durante o upload do arquivo'
            });
        });
    }

    private async subscribe(call: grpc.ServerWritableStream<any, any>) {
        const subscriptionService = new SubscriptionService(this.pubSub);
        await subscriptionService.subscribe(call);
    }

    public async generatePerformanceChart() {
        if (this.performanceMetrics.length > 0) {
            await generateChart(this.performanceMetrics);
            console.log('Gráfico de desempenho gerado com sucesso!');
            this.performanceMetrics = [];
        }
    }

    public start() {
        this.server.bindAsync(
            `0.0.0.0:${this.port}`,
            grpc.ServerCredentials.createInsecure(),
            (err, port) => {
                if (err) {
                    console.error('Erro ao iniciar servidor gRPC:', err);
                    return;
                }
            }
        );

        // Gerar gráfico periodicamente
        setInterval(() => this.generatePerformanceChart(), 30000);
    }
}