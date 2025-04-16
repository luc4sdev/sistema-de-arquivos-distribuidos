import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { promises as fs } from 'fs';
import path from 'path';
import { PerformanceMetrics } from './types';

export async function generateChart(metrics: PerformanceMetrics[]): Promise<void> {
    const width = 800;
    const height = 600;
    const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

    const labels = metrics.map((m) => m.operation);
    const data = metrics.map((m) => m.timeMs);

    const configuration: any = {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Tempo (ms)',
                    data,
                    backgroundColor: 'rgba(14, 208, 30, 0.41)',
                    borderColor: 'rgb(34, 245, 10)',
                    borderWidth: 1,
                },
            ],
        },
        options: {
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Tempo (ms)' },
                },
                x: {
                    title: { display: true, text: 'Operação' },
                },
            },
        },
    };

    const imageBuffer = await chartJSNodeCanvas.renderToBuffer(configuration);
    await fs.writeFile(path.join(__dirname, `../charts/performance.png`), imageBuffer);
}

export async function measureTime<T>(fn: () => Promise<T>): Promise<{ result: T; timeMs: number }> {
    const start = process.hrtime();
    const result = await fn();
    const [seconds, nanoseconds] = process.hrtime(start);
    const timeMs = seconds * 1000 + nanoseconds / 1e6;
    return { result, timeMs };
}