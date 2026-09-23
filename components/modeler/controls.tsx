import type { ReactNode } from "react";

import type { Vector3Tuple } from "./runtime/scene";

export function PanelSection({ title, aside, children }: { title: string; aside?: string; children: ReactNode }) {
  return (
    <section className="modeler-section">
      <div className="modeler-section-title">{title}<span>{aside}</span></div>
      {children}
    </section>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.1,
  range = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  range?: boolean;
}) {
  return (
    <div className="modeler-field">
      <label>{label}</label>
      <input
        type={range ? "range" : "number"}
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </div>
  );
}

export function VectorFields({
  label,
  value,
  onChange,
  step = 0.1,
  min,
  max,
}: {
  label: string;
  value: Vector3Tuple;
  onChange: (value: Vector3Tuple) => void;
  step?: number;
  min?: number;
  max?: number;
}) {
  return (
    <div className="modeler-field">
      <label>{label}</label>
      <div className="modeler-fields-3">
        {(["X", "Y", "Z"] as const).map((axis, index) => (
          <input
            key={axis}
            aria-label={`${label} ${axis}`}
            type="number"
            value={Number.isFinite(value[index]) ? value[index] : 0}
            step={step}
            min={min}
            max={max}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next)) return;
              const updated = [...value] as Vector3Tuple;
              updated[index] = next;
              onChange(updated);
            }}
          />
        ))}
      </div>
    </div>
  );
}
