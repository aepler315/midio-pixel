import { parentPort, workerData } from 'node:worker_threads';
import { evaluateFieldSamples } from './view-quality.mjs';

parentPort.postMessage(evaluateFieldSamples(workerData));
