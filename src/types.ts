export type Timer = NodeJS.Timer | number;

export type AsyncOperationOptions = {
  // `timeout` specifies the number of milliseconds before the operation times out.
  // If the operation takes longer than `timeout`, the operation will be aborted and
  // the underlying promise will be rejected with a TimeoutError.
  // The concrete operation must provide a default value for `timeout`.
  timeout?: number;

  // An AbortSignal. If this option is set, the operation will be canceled by
  // calling abort() on the AbortSignal.
  signal?: AbortSignal;
};
