interface AudioWorkletRegistry {
    'strudel-processor': {
        in: import('./src/types/event-queue').WorkletInboundMsg;
        out: import('./src/types/event-queue').WorkletOutboundMsg;
        options: {
            wasmModule: WebAssembly.Module;
            sampleRate: number;
            sharedMemory: WebAssembly.Memory;
            /** Seed for the audio-synthesis RNG (noise/crackle/grain). */
            rngSeed: number;
        };
    };
    /** Lossless capture tap: copies its input into a shared ring buffer. */
    'wav-tap': {
        in: never;
        out: never;
        options: {
            /** Control header (4x Int32) followed by interleaved Float32 frames. */
            ring: SharedArrayBuffer;
            /** Ring capacity in frames. */
            capacity: number;
        };
    };
}

/**
 * Extended options to strictly type processorOptions based on the registry key.
 */
interface TypedAudioWorkletNodeOptions<K extends keyof AudioWorkletRegistry> extends AudioWorkletNodeOptions {
    processorOptions: AudioWorkletRegistry[K]['options'];
}

interface TypedPort<In, Out> extends MessagePort {
    postMessage(message: Out, transfer: Transferable[]): void;

    postMessage(message: Out, options?: StructuredSerializeOptions): void;

    onmessage: ((this: MessagePort, ev: MessageEvent<In>) => any) | null;

    addEventListener(type: 'message', listener: (this: MessagePort, ev: MessageEvent<In>) => any, options?: boolean | AddEventListenerOptions): void;

    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

declare class AudioWorkletProcessor<K extends keyof AudioWorkletRegistry> {
    readonly port: TypedPort<
        AudioWorkletRegistry[K]['in'],
        AudioWorkletRegistry[K]['out']
    >;

    constructor();

    abstract process(
        inputs: Float32Array[][],
        outputs: Float32Array[][],
        parameters: Record<string, Float32Array>
    ): boolean;
}

interface TypedAudioWorkletNode<K extends keyof AudioWorkletRegistry> extends Omit<AudioWorkletNode, 'port'> {
    readonly port: TypedPort<
        AudioWorkletRegistry[K]['out'],
        AudioWorkletRegistry[K]['in']
    >;
}

interface TypedAudioWorkletNodeCtor {
    new<K extends keyof AudioWorkletRegistry>(
        context: BaseAudioContext,
        name: K,
        options?: TypedAudioWorkletNodeOptions<K>
    ): TypedAudioWorkletNode<K>;
}

type ProcessorConstructor<K extends keyof AudioWorkletRegistry> = {
    new(options: TypedAudioWorkletNodeOptions<K>): AudioWorkletProcessor<K>;
    parameterDescriptors?: AudioParamDescriptor[];
};

declare function registerProcessor<K extends keyof AudioWorkletRegistry>(
    name: K,
    processorCtor: ProcessorConstructor<K>
): void;
