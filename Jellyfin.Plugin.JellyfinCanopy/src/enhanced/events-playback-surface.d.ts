// src/enhanced/events-playback-surface.d.ts
// JEGlobal surface owned by the events/playback modules (frozen public contract).
import type {} from '../types/jc';

declare module '../types/jc' {
    interface JEGlobal {
        // enhanced/events
        keyListener?: (e: KeyboardEvent) => void;
        initializeCanopyScript?: () => void;

        // enhanced/playback
        openSettings?: (cb: () => void) => void;
        adjustPlaybackSpeed?: (direction: 'increase' | 'decrease') => void;
        resetPlaybackSpeed?: () => void;
        jumpToPercentage?: (percentage: number) => void;
        frameStep?: (direction: 'forward' | 'back') => Promise<void>;
        attachSeekTracker?: (video: HTMLVideoElement) => void;
        jumpToLastPosition?: () => void;
        skipIntroOutro?: () => void;
        cycleSubtitleTrack?: () => void;
        cycleAudioTrack?: () => void;
        cycleAspect?: () => void;
        initializeAutoSkipObserver?: () => void;
        stopAutoSkip?: () => void;
        handleLongPressDown?: (e: Event) => void;
        handleLongPressUp?: (e: Event) => void;
        handleLongPressCancel?: (e: Event) => void;
        handleLongPressMove?: (e: Event) => void;
        handleLongPressClick?: (e: Event) => void;
    }
}
