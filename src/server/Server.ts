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
import * as fs from 'fs/promises';

const PROTO_PATH = path.join(__dirname, '../proto/filesystem.proto');
const CHUNK_SIZE = 1024 * 1024; // 1 MB 

export class GRPCServer {
    private server: grpc.Server;
    private fileServer: FileServer;
    private performanceMetrics: PerformanceMetrics[] = [];
    private pubSub: RedisPubSub;
    private replicationService: ReplicationService;
    private metadataService: MetadataService;
    private benchmarkResults: {
        upload: {
            fileSize: number;
            timeMs: number;
            speed: number;
            cpuUsage: number;  // Adicionado
            memoryUsage: number;  // Adicionado
        }[];
        download: {
            fileSize: number;
            timeMs: number;
            speed: number;
            cpuUsage: number;  // Adicionado
            memoryUsage: number;  // Adicionado
        }[];
    } = {
            upload: [],
            download: []
        };

    private benchmarkActive = false;
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
            DownloadFile: this.downloadFileChunks.bind(this),
            UploadFile: this.handleUploadFile.bind(this),
            ListFiles: this.listFiles.bind(this),
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
        const start = Date.now();
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
            const time_ms = Date.now() - start;  // calcula o tempo decorrido
            return {
                status: 'success',
                time_ms
            };
        } catch (err) {
            console.error(`Erro ao criar arquivo ${filename}:`, err);
            throw err;
        }
    }

    private async writeFile(call: any): Promise<any> {
        const { filename, content } = call.request;
        const start = Date.now();
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
            const time_ms = Date.now() - start;  // calcula o tempo decorrido
            return {
                status: 'success',
                time_ms
            };
        } catch (err) {
            console.error(`Erro ao atualizar arquivo ${filename}:`, err);
            throw err;
        }
    }

    private async deleteFile(call: any): Promise<any> {
        const { filename } = call.request;
        const start = Date.now();
        try {
            await this.pubSub.publish('file_operations', {
                event_type: 'FILE_OPERATION',
                file_path: filename,
                timestamp: Date.now(),
                additional_info: JSON.stringify({
                    operation: 'DELETE',
                })
            });
            const time_ms = Date.now() - start;  // calcula o tempo decorridos
            return { status: 'success', time_ms };
        } catch (err) {
            console.error(`Erro ao deletar arquivo ${filename}:`, err);
            throw err;
        }
    }

    private async readFile(call: any): Promise<any> {
        const { filename } = call.request;
        await this.metadataService.loadAllMetadataFromRedis();
        await this.metadataService.loadAllFromRedis();
        const start = Date.now();
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
            const time_ms = Date.now() - start;  // calcula o tempo decorrido
            return { status: 'success', content, time_ms, node: targetNode };

        } catch (err) {
            console.error(`Erro ao ler arquivo ${filename}:`, err);
            throw err;
        }
    }


    private handleUploadFile(
        call: grpc.ServerReadableStream<any, any>,
        cb: grpc.sendUnaryData<any>
    ) {
        let filename = '';
        let totalChunks = 0;
        let receivedChunks = 0;
        const chunkDistribution: Record<number, string[]> = {};
        const pendingOperations: Promise<void>[] = [];
        let hasError = false;

        // 1. Configuração do timeout para detectar stalls
        const operationTimeout = setTimeout(() => {
            if (!hasError && receivedChunks < totalChunks) {
                const err = new Error(`Timeout: apenas ${receivedChunks}/${totalChunks} chunks recebidos`);
                console.error(err.message);
                call.destroy(err);
            }
        }, 30000); // 30 segundos de timeout

        call.on('data', (chunkMsg: any) => {
            if (hasError) return;

            try {
                if (!filename) {
                    filename = chunkMsg.filename;
                    totalChunks = chunkMsg.total_chunks;
                }

                receivedChunks++;
                const chunkNumber = chunkMsg.chunk_number;

                // 2. Processamento assíncrono com controle de concorrência
                const processPromise = (async () => {
                    try {
                        await this.metadataService.loadAllFromRedis();
                        const availableNodes = this.metadataService.getAvailableNodes();

                        if (availableNodes.length < 2) {
                            throw new Error('Nós insuficientes para replicação');
                        }

                        const primaryNode = availableNodes[chunkNumber % availableNodes.length];
                        const replicaNode = availableNodes[(chunkNumber + 1) % availableNodes.length];
                        const targetNodes = [primaryNode, replicaNode];

                        // 3. Armazena distribuição ANTES de enviar para evitar race condition
                        chunkDistribution[chunkNumber] = targetNodes;

                        // 4. Envio paralelo com tratamento de erro
                        await Promise.all(
                            targetNodes.map(targetNode =>
                                this.pubSub.publish(`chunk_node_${targetNode}`, {
                                    event_type: 'CHUNK_STORE',
                                    file_path: filename,
                                    timestamp: Date.now(),
                                    additional_info: JSON.stringify({
                                        filename,
                                        chunk_base64: Buffer.from(chunkMsg.chunk).toString('base64'),
                                        chunkNumber,
                                        totalChunks,
                                        checksum: chunkMsg.checksum,
                                        isReplica: targetNode !== primaryNode
                                    })
                                }).catch(err => {
                                    console.error(`Erro ao publicar para ${targetNode}:`, err);
                                    throw err;
                                })
                            )
                        );
                    } catch (e) {
                        hasError = true;
                        throw e;
                    }
                })();

                pendingOperations.push(processPromise);
            } catch (e) {
                hasError = true;
                console.error('Erro no processamento do chunk:', e);
                call.destroy(e as Error);
            }
        });

        call.on('end', async () => {
            clearTimeout(operationTimeout);

            try {
                // 5. Espera TODAS as operações concluírem
                await Promise.all(pendingOperations);

                if (hasError) {
                    throw new Error('Operação cancelada devido a erros anteriores');
                }

                // 6. Verificação final de integridade
                if (Object.keys(chunkDistribution).length !== totalChunks) {
                    throw new Error(
                        `Chunks incompletos. Recebidos: ${Object.keys(chunkDistribution).length}, Esperados: ${totalChunks}`
                    );
                }

                console.log(`Todos os ${totalChunks} chunks processados com sucesso`);

                // 7. Registro de metadados
                await this.metadataService.registerFile(
                    filename,
                    'DISTRIBUTED',
                    [],
                    chunkDistribution
                );

                cb(null, {
                    status: 'success',
                    message: `${receivedChunks}/${totalChunks} chunks recebidos e distribuídos`,
                    chunkDistribution,
                    receivedChunks: receivedChunks,
                    totalChunks: totalChunks
                });
            } catch (err) {
                console.error('Erro no processamento final:', err);
                cb({
                    code: grpc.status.INTERNAL,
                    message: `Erro ao registrar metadados: ${(err as Error).message}`
                });
            }
        });

        call.on('error', err => {
            hasError = true;
            clearTimeout(operationTimeout);
            console.error('Erro no upload stream:', err);
            cb({ code: grpc.status.INTERNAL, message: String(err) });
        });
    }

    private async downloadFileChunks(
        call: grpc.ServerWritableStream<any, any>
    ) {
        const { path: filePath } = call.request;

        try {
            // Carrega metadados
            await this.metadataService.loadAllMetadataFromRedis();
            const meta = this.metadataService.getFileMetadata(filePath);

            if (!meta || !meta.chunkDistribution) {
                throw new Error('Arquivo não encontrado ou distribuição de chunks indisponível');
            }
            console.log(Object.keys(meta.chunkDistribution).length)
            // Para cada chunk, encontra um nó disponível e recupera
            for (let chunkNumber = 0; chunkNumber < Object.keys(meta.chunkDistribution).length; chunkNumber++) {
                const possibleNodes = meta.chunkDistribution[chunkNumber];
                let chunkData: Buffer | null = null;

                // Tenta cada nó até conseguir o chunk
                for (const nodeId of possibleNodes) {
                    try {
                        const response = await this.replicationService.requestChunkFromNode(nodeId, filePath, chunkNumber);
                        chunkData = response.chunk;
                        break;
                    } catch (err) {
                        console.warn(`Falha ao obter chunk ${chunkNumber} do nó ${nodeId}:`, err);
                    }
                }

                if (!chunkData) {
                    throw new Error(`Não foi possível recuperar chunk ${chunkNumber}`);
                }

                if (!meta?.chunkDistribution) {
                    throw new Error('Distribuição de chunks não disponível');
                }
                const totalChunks = Object.keys(meta.chunkDistribution).length;
                await new Promise<void>((resolve, reject) => {
                    call.write({
                        filename: filePath,
                        chunk_number: chunkNumber,
                        total_chunks: totalChunks,
                        chunk: chunkData,
                        checksum: crypto.createHash('sha256').update(chunkData).digest('hex')
                    }, (err: any) => err ? reject(err) : resolve());
                });
            }
        } catch (err) {
            console.error(`Erro durante download de ${filePath}:`, err);
            call.emit('error', {
                code: grpc.status.INTERNAL,
                message: `Falha no download: ${(err as Error).message}`
            });
        } finally {
            call.end();
        }
    }



    private listFiles(
        call: grpc.ServerUnaryCall<any, any>,
        callback: grpc.sendUnaryData<any>
    ): void {
        const start = Date.now();  // marca início

        this.metadataService.loadAllMetadataFromRedis()
            .then(() => {
                const allFiles = this.metadataService.getAllFiles();
                const dirPath = call.request.path ?? '';
                const files = dirPath
                    ? allFiles.filter(f => f.startsWith(dirPath))
                    : allFiles;

                const time_ms = Date.now() - start;  // calcula o tempo decorrido

                callback(null, {
                    status: 'success',
                    message: '',
                    files,
                    time_ms,
                });
            })
            .catch((err) => {
                console.error('Erro ao listar arquivos via metadados:', err);
                callback({
                    code: grpc.status.INTERNAL,
                    message: 'Erro ao listar arquivos'
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

    private async benchmarkOperation(
        operation: 'upload' | 'download',
        fileSizeMB: number,
        iterations: number = 3
    ): Promise<void> {
        if (this.benchmarkActive) return;
        this.benchmarkActive = true;

        const testFileName = `benchmark_${fileSizeMB}MB.bin`;
        const testFilePath = path.join(this.storagePath, testFileName);

        try {
            // 1. Preparação do arquivo de teste com verificação
            const fileSizeBytes = fileSizeMB * 1024 * 1024;
            if (!await this.fileExists(testFilePath)) {
                console.log(`Criando arquivo de teste de ${fileSizeMB}MB...`);
                const testData = crypto.randomBytes(fileSizeBytes);
                await fs.writeFile(testFilePath, testData);
            }

            // Verificar tamanho real do arquivo
            const stats = await fs.stat(testFilePath);
            if (stats.size !== fileSizeBytes) {
                throw new Error(`Tamanho do arquivo incorreto (esperado: ${fileSizeBytes} bytes, atual: ${stats.size} bytes)`);
            }

            // 2. Configurações de benchmark
            const results = {
                speeds: [] as number[],
                cpuUsages: [] as number[],
                memoryUsages: [] as number[],
                timings: [] as number[]
            };

            // 3. Loop de iterações
            for (let i = 0; i < iterations; i++) {
                // Pré-aquecimento e limpeza
                if (global.gc) global.gc();
                await new Promise(resolve => setTimeout(resolve, 500));

                // Iniciar monitoramento de recursos
                const startMemory = process.memoryUsage();
                const startCpu = process.cpuUsage();
                const startTime = performance.now();

                // 4. Executar operação com tracking real
                let bytesTransferred = 0;
                if (operation === 'upload') {
                    bytesTransferred = await this.simulateUploadWithTracking(testFileName, testFilePath);
                } else {
                    bytesTransferred = await this.simulateDownloadWithTracking(testFileName);
                }

                // 5. Cálculo das métricas
                const endTime = performance.now();
                const elapsedTimeMs = endTime - startTime;

                // Verificação de integridade
                if (bytesTransferred !== fileSizeBytes) {
                    throw new Error(`Transferência incompleta (esperado: ${fileSizeBytes} bytes, transferido: ${bytesTransferred} bytes)`);
                }

                // Cálculo de velocidade real (MB/s)
                const speedMBps = (fileSizeMB / (elapsedTimeMs / 1000));

                // Cálculo de uso de CPU
                const cpuUsage = process.cpuUsage(startCpu);
                const cpuPercentage = ((cpuUsage.user + cpuUsage.system) / 1000) / elapsedTimeMs;

                // Cálculo de memória
                const endMemory = process.memoryUsage();
                const memoryUsageMB = (endMemory.heapUsed - startMemory.heapUsed) / (1024 * 1024);

                // Armazenar resultados
                results.speeds.push(speedMBps);
                results.cpuUsages.push(Math.max(0, cpuPercentage));
                results.memoryUsages.push(Math.max(0, memoryUsageMB));
                results.timings.push(elapsedTimeMs);

                console.log(`Iteração ${i + 1}: ${speedMBps.toFixed(2)} MB/s, CPU: ${cpuPercentage.toFixed(1)}%, Mem: ${memoryUsageMB.toFixed(2)}MB`);

                await new Promise(resolve => setTimeout(resolve, 1000)); // Resfriamento
            }

            // 6. Cálculo das médias
            const avgSpeed = results.speeds.reduce((a, b) => a + b, 0) / iterations;
            const avgCpu = results.cpuUsages.reduce((a, b) => a + b, 0) / iterations;
            const avgMemory = results.memoryUsages.reduce((a, b) => a + b, 0) / iterations;
            const avgTime = results.timings.reduce((a, b) => a + b, 0) / iterations;

            // 7. Verificação de sanidade
            const maxRealisticSpeed = this.getRealisticSpeedLimit(operation);
            if (avgSpeed > maxRealisticSpeed) {
                console.warn(`AVISO: Velocidade média (${avgSpeed.toFixed(2)} MB/s) acima do limite realista de ${maxRealisticSpeed} MB/s`);
            }

            // 8. Armazenar resultados finais
            this.benchmarkResults[operation].push({
                fileSize: fileSizeMB,
                timeMs: avgTime,
                speed: avgSpeed,
                cpuUsage: avgCpu,
                memoryUsage: avgMemory,

            });

            console.log(`\nResultado final ${operation} (${fileSizeMB}MB):
        Velocidade média: ${avgSpeed.toFixed(2)} MB/s
        Uso médio de CPU: ${avgCpu.toFixed(1)}%
        Uso médio de memória: ${avgMemory.toFixed(2)}MB
        Tempo médio: ${avgTime.toFixed(2)}ms\n`);

        } catch (err) {
            console.error(`Erro no benchmark de ${operation}:`, err);
            // Tentar limpar arquivo de teste em caso de erro
            try { await fs.unlink(testFilePath); } catch { }
        } finally {
            this.benchmarkActive = false;
        }
    }

    private getRealisticSpeedLimit(operation: string): number {
        // Limites realistas baseados em hardware típico
        const limits: Record<string, number> = {
            upload: 5000,   // 5 GB/s (SSD NVMe rápido)
            download: 5000  // 5 GB/s (SSD NVMe rápido)
        };
        return limits[operation] || 1000; // Fallback conservador
    }

    private async simulateUploadWithTracking(filename: string, filePath: string): Promise<number> {
        const fileData = await fs.readFile(filePath);
        let bytesTransferred = 0;

        await new Promise((resolve, reject) => {
            const call = this.handleUploadFile({
                on: (event: any, callback: any) => {
                    if (event === 'data') {
                        for (let i = 0; i < Math.ceil(fileData.length / CHUNK_SIZE); i++) {
                            const chunk = fileData.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
                            bytesTransferred += chunk.length;
                            callback({
                                filename,
                                chunk_number: i,
                                total_chunks: Math.ceil(fileData.length / CHUNK_SIZE),
                                chunk,
                                checksum: crypto.createHash('sha256').update(chunk).digest('hex')
                            });
                        }
                    } else if (event === 'end') {
                        resolve(bytesTransferred);
                    }
                }
            } as any, (err) => err && reject(err));
        });

        return bytesTransferred;
    }

    private async simulateDownloadWithTracking(filename: string): Promise<number> {
        let bytesTransferred = 0;

        await new Promise((resolve, reject) => {
            const call = this.downloadFileChunks({
                request: { path: filename },
                write: (chunk: any) => {
                    if (!chunk.chunk) {
                        reject(new Error("Chunk vazio recebido"));
                        return;
                    }
                    bytesTransferred += chunk.chunk.length;
                },
                end: () => resolve(bytesTransferred),
                emit: (event: any, err: any) => event === 'error' && reject(err)
            } as any);
        });

        return bytesTransferred;
    }
    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    private async simulateUpload(filename: string, filePath: string): Promise<void> {
        const fileData = await fs.readFile(filePath);
        const totalChunks = Math.ceil(fileData.length / CHUNK_SIZE);

        return new Promise((resolve, reject) => {
            const call = this.handleUploadFile({
                on: (event: string, callback: Function) => {
                    if (event === 'data') {
                        // Simular envio de chunks
                        for (let i = 0; i < totalChunks; i++) {
                            const start = i * CHUNK_SIZE;
                            const end = start + CHUNK_SIZE;
                            const chunk = fileData.slice(start, end);

                            callback({
                                filename,
                                chunk_number: i,
                                total_chunks: totalChunks,
                                chunk: chunk,
                                checksum: crypto.createHash('sha256').update(chunk).digest('hex')
                            });
                        }
                    } else if (event === 'end') {
                        callback();
                        resolve();
                    }
                }
            } as any, (err: any, res: any) => {
                if (err) reject(err);
            });
        });
    }

    private async simulateDownload(filename: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const call = this.downloadFileChunks({
                request: { path: filename },
                write: (chunk: any) => { },
                end: () => resolve(),
                emit: (event: string, err: any) => {
                    if (event === 'error') reject(err);
                }
            } as any);
        });
    }

    public async runAllBenchmarks() {
        const sizes = [1, 5, 10, 100]; // Tamanhos em MB

        console.log('Iniciando benchmarks de upload...');
        for (const size of sizes) {
            await this.benchmarkOperation('upload', size);
        }

        console.log('Iniciando benchmarks de download...');
        for (const size of sizes) {
            await this.benchmarkOperation('download', size);
        }

        this.logBenchmarkResults();
    }
    private logBenchmarkResults() {
        console.log('\n=== Resultados dos Benchmarks ===');

        console.log('\nUpload:');
        console.table(this.benchmarkResults.upload);

        console.log('\nDownload:');
        console.table(this.benchmarkResults.download);

        this.generateBenchmarkCharts();
    }
    private async generateBenchmarkCharts() {
        try {
            const { ChartJSNodeCanvas } = await import('chartjs-node-canvas');
            const width = 1000;
            const height = 600;
            const backgroundColour = 'white';

            const chartJSNodeCanvas = new ChartJSNodeCanvas({
                width,
                height,
                backgroundColour
            });

            // Configuração base para os gráficos
            const baseChartOptions = {
                responsive: true,
                plugins: {
                    legend: {
                        position: 'top' as const,
                    },
                    tooltip: {
                        callbacks: {
                            label: (context: any) => {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.y !== null) {
                                    label += context.parsed.y.toFixed(2);
                                    if (context.dataset.label?.includes('Velocidade')) {
                                        label += ' MB/s';
                                    } else if (context.dataset.label?.includes('CPU')) {
                                        label += '%';
                                    } else if (context.dataset.label?.includes('Memória')) {
                                        label += ' MB';
                                    }
                                }
                                return label;
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            };

            // Gráfico de Velocidade
            const speedChartConfig = {
                type: 'bar' as const,
                data: {
                    labels: this.benchmarkResults.upload.map(r => `${r.fileSize}MB`),
                    datasets: [
                        {
                            label: 'Upload - Velocidade (MB/s)',
                            data: this.benchmarkResults.upload.map(r => r.speed),
                            backgroundColor: 'rgba(54, 162, 235, 0.7)',
                            borderColor: 'rgba(54, 162, 235, 1)',
                            borderWidth: 1
                        },
                        {
                            label: 'Download - Velocidade (MB/s)',
                            data: this.benchmarkResults.download.map(r => r.speed),
                            backgroundColor: 'rgba(75, 192, 192, 0.7)',
                            borderColor: 'rgba(75, 192, 192, 1)',
                            borderWidth: 1
                        }
                    ]
                },
                options: {
                    ...baseChartOptions,
                    plugins: {
                        ...baseChartOptions.plugins,
                        title: {
                            display: true,
                            text: 'Velocidade de Transferência',
                            font: { size: 16 }
                        }
                    },
                    scales: {
                        ...baseChartOptions.scales,
                        y: {
                            ...baseChartOptions.scales.y,
                            title: {
                                display: true,
                                text: 'Velocidade (MB/s)'
                            }
                        }
                    }
                }
            };

            // Gráfico de Uso de CPU
            const cpuChartConfig = {
                type: 'line' as const,
                data: {
                    labels: this.benchmarkResults.upload.map(r => `${r.fileSize}MB`),
                    datasets: [
                        {
                            label: 'Upload - Uso de CPU (%)',
                            data: this.benchmarkResults.upload.map(r => r.cpuUsage),
                            backgroundColor: 'rgba(255, 99, 132, 0.2)',
                            borderColor: 'rgba(255, 99, 132, 1)',
                            borderWidth: 2,
                            tension: 0.1,
                            fill: true
                        },
                        {
                            label: 'Download - Uso de CPU (%)',
                            data: this.benchmarkResults.download.map(r => r.cpuUsage),
                            backgroundColor: 'rgba(255, 159, 64, 0.2)',
                            borderColor: 'rgba(255, 159, 64, 1)',
                            borderWidth: 2,
                            tension: 0.1,
                            fill: true
                        }
                    ]
                },
                options: {
                    ...baseChartOptions,
                    plugins: {
                        ...baseChartOptions.plugins,
                        title: {
                            display: true,
                            text: 'Uso de CPU',
                            font: { size: 16 }
                        }
                    },
                    scales: {
                        ...baseChartOptions.scales,
                        y: {
                            ...baseChartOptions.scales.y,
                            title: {
                                display: true,
                                text: 'Uso de CPU (%)'
                            },
                            max: 100
                        }
                    }
                }
            };

            // Gráfico de Uso de Memória
            const memoryChartConfig = {
                type: 'line' as const,
                data: {
                    labels: this.benchmarkResults.upload.map(r => `${r.fileSize}MB`),
                    datasets: [
                        {
                            label: 'Upload - Uso de Memória (MB)',
                            data: this.benchmarkResults.upload.map(r => r.memoryUsage),
                            backgroundColor: 'rgba(153, 102, 255, 0.2)',
                            borderColor: 'rgba(153, 102, 255, 1)',
                            borderWidth: 2,
                            tension: 0.1,
                            fill: true
                        },
                        {
                            label: 'Download - Uso de Memória (MB)',
                            data: this.benchmarkResults.download.map(r => r.memoryUsage),
                            backgroundColor: 'rgba(201, 203, 207, 0.2)',
                            borderColor: 'rgba(201, 203, 207, 1)',
                            borderWidth: 2,
                            tension: 0.1,
                            fill: true
                        }
                    ]
                },
                options: {
                    ...baseChartOptions,
                    plugins: {
                        ...baseChartOptions.plugins,
                        title: {
                            display: true,
                            text: 'Uso de Memória',
                            font: { size: 16 }
                        }
                    },
                    scales: {
                        ...baseChartOptions.scales,
                        y: {
                            ...baseChartOptions.scales.y,
                            title: {
                                display: true,
                                text: 'Uso de Memória (MB)'
                            }
                        }
                    }
                }
            };

            // Gerar as imagens
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const speedImage = await chartJSNodeCanvas.renderToBuffer(speedChartConfig);
            const cpuImage = await chartJSNodeCanvas.renderToBuffer(cpuChartConfig);
            const memoryImage = await chartJSNodeCanvas.renderToBuffer(memoryChartConfig);

            // Salvar os arquivos
            await Promise.all([
                fs.writeFile(`benchmark-speed-${timestamp}.png`, speedImage),
                fs.writeFile(`benchmark-cpu-${timestamp}.png`, cpuImage),
                fs.writeFile(`benchmark-memory-${timestamp}.png`, memoryImage)
            ]);

            console.log('Gráficos de benchmark gerados com sucesso!');
            console.log(`- Velocidade: benchmark-speed-${timestamp}.png`);
            console.log(`- CPU: benchmark-cpu-${timestamp}.png`);
            console.log(`- Memória: benchmark-memory-${timestamp}.png`);
        } catch (err) {
            console.error('Erro ao gerar gráficos:', err);
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