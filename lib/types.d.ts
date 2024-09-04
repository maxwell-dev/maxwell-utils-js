export type Timer = NodeJS.Timer | number;
export type AsyncOperationOptions = {
    timeout?: number;
    signal?: AbortSignal;
};
