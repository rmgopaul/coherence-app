const fs = require('fs');
const path = require('path');

const files = [
  { file: 'APsystemsMeterReads.tsx', key: 'apsystems', label: 'APsystems', id: 'systemId' },
  { file: 'EgaugeMeterReads.tsx', key: 'egauge', label: 'eGauge', id: 'meterIdOverride || credentialId' },
  { file: 'EkmMeterReads.tsx', key: 'ekm', label: 'EKM', id: 'meterNumber' },
  { file: 'EnnexOsMeterReads.tsx', key: 'ennexos', label: 'ennexOS', id: 'plantId' },
  { file: 'EnphaseV4MeterReads.tsx', key: 'enphase-v4', label: 'Enphase V4', id: 'systemId' },
  { file: 'FroniusMeterReads.tsx', key: 'fronius', label: 'Fronius', id: 'pvSystemId' },
  { file: 'GeneracMeterReads.tsx', key: 'generac', label: 'Generac', id: 'systemId' },
  { file: 'GoodWeMeterReads.tsx', key: 'goodwe', label: 'GoodWe', id: 'stationId' },
  { file: 'GrowattMeterReads.tsx', key: 'growatt', label: 'Growatt', id: 'plantId' },
  { file: 'HoymilesMeterReads.tsx', key: 'hoymiles', label: 'Hoymiles', id: 'stationId' },
  { file: 'LocusMeterReads.tsx', key: 'locus', label: 'Locus Energy', id: 'siteId' },
  { file: 'SolarEdgeMeterReads.tsx', key: 'solaredge', label: 'SolarEdge', id: 'siteId' },
  { file: 'SolarLogMeterReads.tsx', key: 'solarlog', label: 'SolarLog', id: 'deviceId' },
  { file: 'SolisMeterReads.tsx', key: 'solis', label: 'Solis', id: 'stationId' },
  { file: 'TeslaPowerhubMeterReads.tsx', key: 'tesla-powerhub', label: 'Tesla Powerhub', id: 'siteId' },
];

const dir = 'client/src/solar-rec/pages/meter-reads';

files.forEach(f => {
  const filePath = path.join(dir, f.file);
  let content = fs.readFileSync(filePath, 'utf8');

  if (!content.includes('PersistConfirmation')) {
    content = content.replace(
      'import { useState } from "react";',
      'import { useState } from "react";\nimport { PersistConfirmation } from "../../components/PersistConfirmation";'
    );
  }

  if (!content.includes('setShowPersist')) {
    content = content.replace(
      'const result = snapshotMutation.data;',
      'const [showPersist, setShowPersist] = useState(false);\n  const result = snapshotMutation.data;'
    );
  }

  if (!content.includes('setShowPersist(true)')) {
    content = content.replace(
      'snapshotMutation.mutate(',
      'setShowPersist(true);\n    snapshotMutation.mutate('
    );
  }

  if (!content.includes('<PersistConfirmation')) {
    content = content.replace(
      /\{result && \([\s\S]*?<\/div>\s*\)\}\s*<\/CardContent>/,
      match => {
        const parts = match.split("</CardContent>");
        return parts[0] + `
          {result && (result as any).status === "Found" && (result as any).lifetimeKwh != null && showPersist && (
            <PersistConfirmation
              providerKey="${f.key}"
              providerLabel="${f.label}"
              rows={[{
                monitoring: "${f.label}",
                monitoring_system_id: String(${f.id}),
                monitoring_system_name: String((result as any).name || (result as any).systemName || ${f.id}),
                lifetime_meter_read_wh: String(Math.round(Number((result as any).lifetimeKwh) * 1000)),
                read_date: typeof anchorDate !== 'undefined' && anchorDate ? anchorDate : new Date().toISOString().slice(0, 10),
                status: "",
                alert_severity: ""
              }]}
              onDiscard={() => setShowPersist(false)}
            />
          )}
        </CardContent>` + parts[1];
      }
    );
  }

  fs.writeFileSync(filePath, content);
  console.log('patched ' + f.file);
});
