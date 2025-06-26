import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path, { join } from 'path';
import { FileServer } from './FileServer';
import { measureTime } from '../utils';
import { PerformanceMetrics } from '../types';
import { generateChart } from '../utils';
import { RedisPubSub } from '../redis/RedisPubSub';
import { ReplicationService } from './replicationService';
import { MetadataService } from './metadataService';
import { SubscriptionService } from '../redis/SubscriptionService';
import { existsSync, readFileSync } from 'fs';

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
            //ListFiles: this.wrapWithMetrics(this.listFiles.bind(this), 'list'),
            CopyFile: this.wrapWithMetrics(this.copyFile.bind(this), 'copy'),
            DownloadFile: this.wrapWithMetrics(this.downloadFile.bind(this), 'download'),
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

        try {
            const metadata = this.metadataService.getFileMetadata(filename);
            if (!metadata) {
                throw new Error(`Arquivo ${filename} não encontrado`);
            }

            const result = await this.fileServer.readFileWithFallback({
                filename,
                preferredNode: metadata.primaryNode,
                replicaNodes: metadata.replicaNodes
            });

            return result;
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

    // private async listFiles(call: any): Promise<any> {
    //     const { path } = call.request;

    //     try {
    //         const result = await this.fileServer.listFiles({
    //             path,
    //             nodeId: this.nodeId
    //         });

    //         return {
    //             ...result,
    //             node: this.nodeId
    //         };
    //     } catch (err) {
    //         console.error(`Erro ao listar arquivos em ${path}:`, err);
    //         throw err;
    //     }
    // }



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