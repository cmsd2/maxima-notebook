/**
 * Result from evaluating a cell via aximar-mcp. A label the session can't
 * resolve comes back with only `error`, `is_error` and `execution_count`.
 */
export interface EvalResult {
  text_output?: string;
  latex?: string | null;
  plot_svg?: string | null;
  plot_data?: string | null;
  image_png?: string | null;
  error?: string | null;
  is_error: boolean;
  duration_ms?: number;
  output_label?: string | null;
  /** The run's gutter number, from the server */
  execution_count?: number | null;
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
