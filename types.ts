
export interface TranscriptionEntry {
  id: string;
  speaker: 'user' | 'model';
  text: string;
  timestamp: Date;
}

export enum ConnectionStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  ERROR = 'ERROR'
}

export enum AppMode {
  TRANSLATE = 'TRANSLATE',
  CHAT = 'CHAT'
}

export interface VoiceState {
  isSpeaking: boolean;
  volume: number;
}
