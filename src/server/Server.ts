import express, { Express, Request, Response, NextFunction } from 'express';
import { createServer, Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { FileServer } from './FileServer';
import { SocketHandler } from './SocketHandler';
import path from 'path';
import fs from 'fs/promises';

export class Server {
    private app: Express;
    private httpServer: HttpServer;
    private io: SocketServer;
    private fileServer: FileServer;

    constructor() {
        this.app = express();
        this.httpServer = createServer(this.app);
        this.io = new SocketServer(this.httpServer);
        this.fileServer = new FileServer();
        this.setupMiddleware();
        this.setupRoutes();
        new SocketHandler(this.io);
    }

    private setupMiddleware() {
        this.app.use(express.json());
    }

    private setupRoutes() {
        // Listar arquivos
        this.app.get('/files', async (req: Request, res: Response) => {
            try {
                const { path: dirPath = '' } = req.query;
                const result = await this.fileServer.listFiles({ path: dirPath as string });
                if (result.status === 'error') {
                    res.status(400).json(result);
                    return
                }
                res.json(result);
            } catch (err) {
                res.status(500).json({
                    status: 'error',
                    message: (err as Error).message
                });
            }
        });


        // Download de arquivo
        this.app.get('/files/download', async (req: Request, res: Response) => {
            try {
                const { path: filePath, name: outputName } = req.query;

                if (!filePath) {
                    res.status(400).json({
                        status: 'error',
                        message: 'O parâmetro "path" é obrigatório'
                    });
                    return
                }

                const result = await this.fileServer.downloadFile({
                    path: filePath as string,
                    outputName: outputName as string | undefined
                });

                if (result.status === 'error') {
                    res.status(400).json(result);
                    return
                }

                if (result.filename && result.content) {
                    const buffer = Buffer.from(result.content, 'base64');
                    res.setHeader('Content-Disposition', `attachment; filename=${result.filename}`);
                    res.setHeader('Content-Type', 'application/octet-stream');
                    res.send(buffer);
                    return
                }

                res.json(result);
            } catch (err) {
                res.status(500).json({
                    status: 'error',
                    message: (err as Error).message
                });
            }
        });

        // Copiar arquivo
        this.app.post('/files/copy', async (req: Request, res: Response) => {
            try {
                const { source, destination } = req.body;

                if (!source || !destination) {
                    res.status(400).json({
                        status: 'error',
                        message: 'Os parâmetros "source" e "destination" são obrigatórios'
                    });
                    return
                }

                const result = await this.fileServer.copyFile({ source, destination });
                res.json(result);
            } catch (err) {
                res.status(500).json({
                    status: 'error',
                    message: (err as Error).message
                });
            }
        });

        // Rota para arquivos estáticos
        this.app.get('/files/static/:filename', async (req: Request, res: Response) => {
            try {
                const { filename } = req.params;
                const filePath = path.join(__dirname, '../../files', filename);

                await fs.access(filePath); // Verifica se o arquivo existe
                res.sendFile(filePath);
            } catch (err) {
                res.status(500).json({
                    status: 'error',
                    message: (err as Error).message
                });
            }
        });
    }

    public start(port: number) {
        this.httpServer.listen(port, () => {
            console.log(`Servidor rodando na porta ${port}`);
            console.log(`WebSocket disponível em ws://localhost:${port}`);
            console.log(`API REST disponível em http://localhost:${port}/files`);
        });
    }
}