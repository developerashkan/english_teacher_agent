
export interface TranscriptionMessage {
  role: 'user' | 'professor';
  text: string;
  timestamp: number;
}

export enum SessionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}
