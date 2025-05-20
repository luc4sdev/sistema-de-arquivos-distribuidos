import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as fs from 'fs';
import * as path from 'path';
import { FileOperationResponse } from '../types';
import { createClient, RedisClientType } from 'redis';
import { Notification } from '../types'

const PROTO_PATH = path.join(__dirname, '../proto/filesystem.proto');

export class FileClient {
    private client: any;
    private serverAddress: string;
    private redisSubscriber: RedisClientType;
    private subscribedChannels: string[];

    constructor(serverAddress: string = 'localhost:50051') {
        this.serverAddress = serverAddress;
        this.initializeClient();
        this.redisSubscriber = createClient({ url: 'redis://localhost:6379' });
        this.subscribedChannels = [];
        this.setupRedis();
    }

    private async setupRedis() {
        await this.redisSubscriber.connect();
        this.redisSubscriber.on('error', (err) => {
            console.error('Redis Error:', err);
        });
    }

    public async subscribe(paths: string[], callback: (notification: Notification) => void) {
        for (const rawPath of paths) {
            const path = rawPath.toLowerCase();

            // Assina o caminho específico
            const specificChannel = `file_events:${path}`;
            await this.subscribeToChannel(specificChannel, callback);

            // Assina todos os caminhos pai
            let parentPath = path;
            while (parentPath.includes('/')) {
                parentPath = parentPath.substring(0, parentPath.lastIndexOf('/'));
                if (parentPath) {
                    const parentChannel = `file_events:${parentPath}`;
                    await this.subscribeToChannel(parentChannel, callback);
                }
            }

            // Assina o root
            await this.subscribeToChannel('file_events:', callback);
        }
    }

    private async subscribeToChannel(channel: string, callback: (notification: Notification) => void) {
        if (this.subscribedChannels.includes(channel)) return;

        await this.redisSubscriber.subscribe(channel, (message) => {
            try {
                const notification = JSON.parse(message);
                callback(notification);
            } catch (err) {
                console.error('Error parsing notification:', err);
            }
        });

        this.subscribedChannels.push(channel);
        console.log(`Subscribed to channel: ${channel}`);
    }

    public async unsubscribe() {
        for (const channel of this.subscribedChannels) {
            await this.redisSubscriber.unsubscribe(channel);
        }
        this.subscribedChannels = [];
    }

    private initializeClient() {
        const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
            keepCase: true,
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true
        });

        const protoDescriptor = grpc.loadPackageDefinition(packageDefinition) as any;
        this.client = new protoDescriptor.filesystem.FileSystem(
            this.serverAddress,
            grpc.credentials.createInsecure()
        );
    }

    public onConnect(callback: () => void) {
        process.nextTick(callback);
    }

    public async createFile(filename: string, content: string): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            this.client.CreateFile({ filename, content }, (err: any, response: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Criar arquivo:', response, `Tempo: ${response.timeMs}ms`);
                resolve(response);
            });
        });
    }

    public async readFile(filename: string): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            this.client.ReadFile({ filename }, (err: any, response: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Ler arquivo:', response, `Tempo: ${response.timeMs}ms`);
                resolve(response);
            });
        });
    }

    public async writeFile(filename: string, content: string): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            this.client.WriteFile({ filename, content }, (err: any, response: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Escrever arquivo:', response, `Tempo: ${response.timeMs}ms`);
                resolve(response);
            });
        });
    }

    public async deleteFile(filename: string): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            this.client.DeleteFile({ filename }, (err: any, response: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Excluir arquivo:', response, `Tempo: ${response.timeMs}ms`);
                resolve(response);
            });
        });
    }

    public async listFiles(path: string = ''): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            this.client.ListFiles({ path }, (err: any, response: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Listar arquivos:', response, `Tempo: ${response.timeMs}ms`);
                if (response.files) {
                    console.log('Arquivos:');
                    response.files.forEach((file: any) => {
                        console.log(`- ${file.name}${file.isDirectory ? '/' : ''}`);
                    });
                }
                resolve(response);
            });
        });
    }

    public async copyFile(source: string, destination: string): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            this.client.CopyFile({ source, destination }, (err: any, response: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Copiar arquivo:', response, `Tempo: ${response.timeMs}ms`);
                resolve(response);
            });
        });
    }

    public async downloadFile(remotePath: string, outputName?: string): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            this.client.DownloadFile({
                path: remotePath,
                output_name: outputName
            }, (err: any, response: any) => {
                if (err) {
                    reject(err);
                    return;
                }
                console.log('Download arquivo:', response, `Tempo: ${response.timeMs}ms`);
                if (response.content && response.filename) {
                    const decodedContent = Buffer.from(response.content, 'base64');
                    const outputDir = path.resolve(__dirname, '../../', 'localFiles');
                    if (!fs.existsSync(outputDir)) {
                        fs.mkdirSync(outputDir, { recursive: true });
                    }
                    const localPath = path.join(outputDir, outputName || response.filename);
                    fs.writeFileSync(localPath, decodedContent);
                    console.log(`Arquivo ${response.filename} baixado com sucesso!`);
                }
                resolve(response);
            });
        });
    }

    public async runExampleOperations(): Promise<void> {
        await this.createFile('teste.txt', 'Hello World\n');
        await this.listFiles();
        await this.readFile('teste.txt');
        await this.copyFile('teste.txt', 'copia_teste.txt');
        await this.writeFile('teste.txt', 'Mais texto\n');
        await this.readFile('teste.txt');
        await this.downloadFile('teste.txt');
    }

    public disconnect() {
        this.redisSubscriber.quit();
        // gRPC não precisa de desconexão explícita
        // O canal será fechado automaticamente quando não estiver mais em uso
    }
}