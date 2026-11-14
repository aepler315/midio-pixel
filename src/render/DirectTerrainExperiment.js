import { settingValue } from '../config/appSettings.js';

/** The experimental terrain-only pixel pipeline (registry id directTerrain). */
export function directTerrainExperiment(search) {
  return settingValue('directTerrain', search);
}
