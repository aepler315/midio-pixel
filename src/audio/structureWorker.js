import { analyzeStructure, boundedStructureInput } from './StructureAnalyzer.js';
import { EnergyCurves } from './EnergyCurves.js';
self.onmessage = e => {
  try {
    const input = boundedStructureInput(e.data);
    if (input.energyCurves) {
      const curves = Object.assign(new EnergyCurves(1), input.energyCurves);
      input.energyCurves = curves;
    }
    const structure = analyzeStructure(input);
    self.postMessage({ ok: true, structure });
  } catch (err) { self.postMessage({ ok: false, error: String(err?.message || err) }); }
};
