/**
 * Result from evaluating a cell via aximar-mcp. A label the session can't
 * resolve comes back with only `error`, `is_error` and `execution_count`.
 */
export interface EvalResult {
  text_output?: string;
  latex?: string | null;
  /** The result's one-line form; aximar-mcp after tools 0.6.0 sends it */
  text_plain?: string | null;
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
