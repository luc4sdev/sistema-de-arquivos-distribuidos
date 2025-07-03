import { GRPCServer } from './server/Server';

const server = new GRPCServer();
server.start();
//server.runAllBenchmarks()