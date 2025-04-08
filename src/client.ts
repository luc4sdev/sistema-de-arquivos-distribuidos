import { FileClient } from './client/FileClient';

async function main() {
    const fileClient = new FileClient();

    try {
        await fileClient.runExampleOperations();
    } catch (error) {
        console.error('Erro no cliente:', error);
    } finally {
        //setTimeout(() => fileClient.disconnect(), 5000);
    }
}

main();