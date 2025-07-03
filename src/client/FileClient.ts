import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileOperationResponse } from '../types';

const PROTO_PATH = path.join(__dirname, '../proto/filesystem.proto');
const CHUNK_SIZE = 1024 * 1024; // 1 MB

export class FileClient {
    private client: any;
    private serverAddress: string;

    constructor(serverAddress: string = 'localhost:50050') {
        this.serverAddress = serverAddress;
        this.initializeClient();
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
                console.log('Criar arquivo:', response, `Tempo: ${response.time_ms}ms`);
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
                console.log('Ler arquivo:', response, `Tempo: ${response.time_ms}ms`);
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
                console.log('Escrever arquivo:', response, `Tempo: ${response.time_ms}ms`);
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
                console.log('Excluir arquivo:', response, `Tempo: ${response.time_ms}ms`);
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
                console.log(`📁 Listar arquivos`);
                console.log(`⏱️ Tempo de resposta: ${response.time_ms ?? 'desconhecido'}ms`);

                if (response.files?.length > 0) {
                    response.files.forEach((file: any) => {
                        console.log(`- ${file}`);
                    });
                } else {
                    console.log('⚠️ Nenhum arquivo encontrado.');
                }

                resolve(response);
            });
        });
    }

    public async downloadFile(
        remotePath: string,
        outputName?: string
    ): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {

            /* ----------------------------------------------------------
             * 1.  Abre stream gRPC ― server‑streaming
             * -------------------------------------------------------- */
            const call = this.client.DownloadFile({ path: remotePath });

            /* variáveis de controle */
            let totalChunks = 0;
            let received = 0;
            let writeStream: fs.WriteStream | null = null;
            const startedAt = Date.now();

            /* ----------------------------------------------------------
             * 2.  Evento “data”  →  grava pedaço
             * -------------------------------------------------------- */
            call.on('data', (chunkMsg: any) => {
                /* abre o arquivo no primeiro pedaço */
                if (!writeStream) {
                    totalChunks = chunkMsg.total_chunks;                 // meta
                    const outDir = path.resolve(__dirname, '../../downloads');
                    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

                    const fname = outputName || path.basename(remotePath);
                    writeStream = fs.createWriteStream(path.join(outDir, fname));
                }

                writeStream!.write(chunkMsg.chunk);                     // grava bytes
                received++;
                process.stdout.write(
                    `\r⬇️  recebidos ${received}/${totalChunks} chunks…`
                );
            });

            /* ----------------------------------------------------------
             * 3.  Tratamento de erro
             * -------------------------------------------------------- */
            call.on('error', (err: any) => {
                if (writeStream) writeStream.close();
                console.error('\nErro no stream de download:', err.message);
                reject(err);
            });

            /* ----------------------------------------------------------
             * 4.  Stream terminado
             * -------------------------------------------------------- */
            call.on('end', () => {
                if (writeStream) writeStream.end();
                const dt = Date.now() - startedAt;
                console.log(`\n✅ Download concluído em ${dt} ms`);

                resolve({
                    status: 'success',
                    message: 'download completo',
                    time_ms: dt
                } as FileOperationResponse);
            });
        });
    }

    public async uploadFile(localPath: string, remoteFilename: string): Promise<FileOperationResponse> {
        return new Promise((resolve, reject) => {
            const stream = fs.createReadStream(localPath, { highWaterMark: CHUNK_SIZE });
            const call = this.client.UploadFile((err: any, response: any) => {
                if (err) {
                    reject(err);
                } else {
                    console.log('Upload completo:', response);
                    resolve(response);
                }
            });

            let chunkNumber = 0;
            const fileSize = fs.statSync(localPath).size;
            const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

            stream.on('data', (chunk: Buffer | string) => {
                const chunkChecksum = crypto.createHash('sha256').update(chunk).digest('hex');
                call.write({
                    filename: remoteFilename,
                    chunk: chunk,
                    chunk_number: chunkNumber,
                    total_chunks: totalChunks,
                    checksum: chunkChecksum
                });
                chunkNumber++;
            });

            stream.on('end', () => {
                call.end();
            });

            stream.on('error', (err) => {
                call.cancel();
                reject(err);
            });
        });
    }
}