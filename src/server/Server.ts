import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { FileServer } from './FileServer';
import { measureTime } from '../utils';
import { PerformanceMetrics } from '../types';
import { generateChart } from '../utils';
import { RedisPubSub } from '../redis/RedisPubSub';

const PROTO_PATH = path.join(__dirname, '../proto/filesystem.proto');

export class GRPCServer {
    private server: grpc.Server;
    private fileServer: FileServer;
    private performanceMetrics: PerformanceMetrics[] = [];
    private pubSub: RedisPubSub;

    constructor() {
        this.fileServer = new FileServer();
        this.server = new grpc.Server();
        this.setupGRPC();
        this.pubSub = new RedisPubSub();
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
            ListFiles: this.wrapWithMetrics(this.listFiles.bind(this), 'list'),
            CopyFile: this.wrapWithMetrics(this.copyFile.bind(this), 'copy'),
            DownloadFile: this.wrapWithMetrics(this.downloadFile.bind(this), 'download')
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
        const result = await this.fileServer.createFile({ filename, content });
        await this.pubSub.publishToPath('file_events', {
            event_type: 'CREATE',
            file_path: filename,
            timestamp: Date.now(),
            additional_info: ''
        });
        return result;
    }

    private async readFile(call: any): Promise<any> {
        const { filename } = call.request;
        const result = await this.fileServer.readFile({ filename });
        return result;
    }

    private async writeFile(call: any): Promise<any> {
        const { filename, content } = call.request;
        const result = await this.fileServer.writeFile({ filename, content });
        await this.pubSub.publishToPath('file_events', {
            event_type: 'MODIFY',
            file_path: filename,
            timestamp: Date.now(),
            additional_info: ''
        });
        return result;
    }

    private async deleteFile(call: any): Promise<any> {
        const { filename } = call.request;
        const result = await this.fileServer.deleteFile({ filename });
        await this.pubSub.publishToPath('file_events', {
            event_type: 'DELETE',
            file_path: filename,
            timestamp: Date.now(),
            additional_info: ''
        });
        return result;
    }

    private async listFiles(call: any): Promise<any> {
        const { path } = call.request;
        const result = await this.fileServer.listFiles({ path });
        return result;
    }

    private async copyFile(call: any): Promise<any> {
        const { source, destination } = call.request;
        const result = await this.fileServer.copyFile({ source, destination });
        return result;
    }

    private async downloadFile(call: any): Promise<any> {
        const { path, output_name } = call.request;
        const result = await this.fileServer.downloadFile({
            path,
            outputName: output_name
        });
        return result;
    }

    public async generatePerformanceChart() {
        if (this.performanceMetrics.length > 0) {
            await generateChart(this.performanceMetrics);
            console.log('Gráfico de desempenho gerado com sucesso!');
            this.performanceMetrics = [];
        }
    }

    public start(port: number) {
        this.server.bindAsync(
            `0.0.0.0:${port}`,
            grpc.ServerCredentials.createInsecure(),
            (err, port) => {
                if (err) {
                    console.error('Erro ao iniciar servidor gRPC:', err);
                    return;
                }
                console.log(`Servidor gRPC rodando na porta ${port}`);
                this.server.start();
            }
        );

        // Gerar gráfico periodicamente (opcional)
        setInterval(() => this.generatePerformanceChart(), 30000);
    }
}