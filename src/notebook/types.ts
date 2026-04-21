/** Result from evaluating a Maxima expression via aximar-mcp. */
export interface EvalResult {
  text_output: string;
  latex: string | null;
  plot_svg: string | null;
  plot_data: string | null;
  image_png: string | null;
  error: string | null;
  is_error: boolean;
  duration_ms: number;
  output_label: string | null;
}

/** Metadata stored per notebook cell. */
export interface MaximaCellMetadata {
  outputLabel?: string;
  executionCount?: number;
}

/** Context for rewriting % and %oN/%iN labels before evaluation. */
export interface LabelContext {
  /** Maps display execution count → real Maxima output label (e.g. 1 → "%o6") */
  labelMap: Map<number, string>;
  /** The real output label of the most recent previous cell (for bare %) */
  previousOutputLabel: string | undefined;
}

// ── ipynb format types ──────────────────────────────────────────────

export interface IpynbNotebook {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: IpynbCell[];
}

export interface IpynbCell {
  cell_type: string;
  source: string[];
  metadata: Record<string, unknown>;
  execution_count?: number | null;
  outputs?: IpynbOutput[];
}

export interface IpynbOutput {
  output_type: string;
  data?: Record<string, string | string[]>;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  text?: string[];
  ename?: string;
  evalue?: string;
  traceback?: string[];
}
