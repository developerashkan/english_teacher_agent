
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { TranscriptionMessage, SessionState } from './types';
import { decode, encode, decodeAudioData, createBlobFromPCM } from './utils/audio';

// Refined System prompt for maximum speed and zero-delay feedback
const SYSTEM_PROMPT = `Role: You are Claire, a fast-responding ESL coach. Your goal is real-time correction with zero delay.

Core Directive: Keep every response under 30 words. Do not give long explanations unless I ask "Why?". Speed and flow are the absolute priorities.

Correction Protocol:
- Immediate Correction: If I make a mistake, state the correction clearly and move on instantly.
- Pronunciation: If I misspeak, say: "Try saying [Word] like this: [Simple Phonetic]."
- No Lectures: Do not explain grammar rules unless I am explicitly stuck or ask "Why?".
- Natural Transition: Correct me, then immediately ask a very short question to keep the conversation flowing.

Voice Style: Friendly, direct, and concise. Use a natural, conversational pace. Zero delay is the mission.`;

const App: React.FC = () => {
  const [sessionState, setSessionState] = useState<SessionState>(SessionState.DISCONNECTED);
  const [messages, setMessages] = useState<TranscriptionMessage[]>([]);
  const [isProfessorSpeaking, setIsProfessorSpeaking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const sessionRef = useRef<any>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  const currentInputTransRef = useRef<string>('');
  const currentOutputTransRef = useRef<string>('');

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const stopAllAudio = () => {
    audioSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setIsProfessorSpeaking(false);
  };

  const handleStartSession = async () => {
    try {
      setSessionState(SessionState.CONNECTING);
      setErrorMessage(null);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      inputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: SYSTEM_PROMPT,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setSessionState(SessionState.CONNECTED);
            
            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlobFromPCM(inputData);
              sessionPromise.then(session => {
                if (session) session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioCtxRef.current!.destination);
          },
          onmessage: async (message) => {
            if (message.serverContent?.inputTranscription) {
              currentInputTransRef.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTransRef.current += message.serverContent.outputTranscription.text;
            }
            if (message.serverContent?.turnComplete) {
              if (currentInputTransRef.current) {
                setMessages(prev => [...prev, { role: 'user', text: currentInputTransRef.current, timestamp: Date.now() }]);
              }
              if (currentOutputTransRef.current) {
                setMessages(prev => [...prev, { role: 'professor', text: currentOutputTransRef.current, timestamp: Date.now() }]);
              }
              currentInputTransRef.current = '';
              currentOutputTransRef.current = '';
            }

            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioCtxRef.current) {
              setIsProfessorSpeaking(true);
              const ctx = outputAudioCtxRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              
              source.onended = () => {
                audioSourcesRef.current.delete(source);
                if (audioSourcesRef.current.size === 0) {
                  setIsProfessorSpeaking(false);
                }
              };

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              audioSourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              stopAllAudio();
            }
          },
          onerror: (err) => {
            console.error("Live session error:", err);
            setErrorMessage("Session timeout. Please restart for zero-delay coaching.");
            setSessionState(SessionState.ERROR);
          },
          onclose: () => {
            setSessionState(SessionState.DISCONNECTED);
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error("Failed to start session:", err);
      setErrorMessage(err.message || "Failed to connect to Claire.");
      setSessionState(SessionState.ERROR);
    }
  };

  const handleStopSession = () => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
    }
    stopAllAudio();
    setSessionState(SessionState.DISCONNECTED);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 md:p-8 text-slate-800">
      <div className="w-full max-w-2xl flex flex-col h-[85vh] glass-card rounded-3xl shadow-2xl overflow-hidden border border-white/40">
        
        {/* Header */}
        <div className="px-8 py-6 bg-white/50 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-200">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-7 w-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 leading-tight">Claire</h1>
              <p className="text-sm text-indigo-600 font-medium tracking-tight">Fast ESL Coach</p>
            </div>
          </div>
          
          <div className="flex items-center space-x-2">
            <div className={`w-3 h-3 rounded-full ${
              sessionState === SessionState.CONNECTED ? 'bg-emerald-500 animate-pulse' : 
              sessionState === SessionState.CONNECTING ? 'bg-amber-400' : 'bg-slate-300'
            }`} />
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              {sessionState.toLowerCase()}
            </span>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-hidden flex flex-col relative">
          
          {/* Messages Scrollbox */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-6 space-y-6 scroll-smooth">
            {messages.length === 0 && sessionState !== SessionState.CONNECTED && (
              <div className="h-full flex flex-col items-center justify-center text-center space-y-4 px-4">
                <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mb-2">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-slate-700">Rapid ESL Coach</h3>
                <p className="text-slate-500 max-w-sm text-sm">
                  Instant corrections. Under 30 words per response. Claire is optimized for zero-delay flow.
                </p>
              </div>
            )}

            {messages.map((m, idx) => (
              <div key={idx} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-5 py-3 shadow-sm ${
                  m.role === 'user' 
                  ? 'bg-indigo-600 text-white rounded-tr-none' 
                  : 'bg-white border border-slate-100 text-slate-800 rounded-tl-none'
                }`}>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{m.text}</p>
                </div>
              </div>
            ))}
            
            {/* Thinking Indicator */}
            {isProfessorSpeaking && (
               <div className="flex justify-start">
                  <div className="bg-white border border-slate-100 rounded-2xl rounded-tl-none px-5 py-3 shadow-sm flex items-center space-x-1">
                    <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" />
                  </div>
               </div>
            )}
          </div>

          {/* Error Message */}
          {errorMessage && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-4/5 z-10">
              <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-2 rounded-xl text-xs flex items-center justify-between shadow-lg">
                <div className="flex items-center space-x-2">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>{errorMessage}</span>
                </div>
                <button onClick={() => setErrorMessage(null)} className="text-rose-400 hover:text-rose-600">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="p-8 bg-slate-50/50 border-t border-slate-100">
          <div className="flex flex-col items-center">
            {sessionState === SessionState.DISCONNECTED || sessionState === SessionState.ERROR ? (
              <button
                onClick={handleStartSession}
                className="group relative flex items-center justify-center w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-semibold text-lg transition-all shadow-xl shadow-indigo-100 hover:shadow-indigo-200 active:scale-[0.98]"
              >
                <span className="mr-2">Start Fast Session</span>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </button>
            ) : (
              <div className="w-full space-y-4">
                <div className="flex items-center justify-center">
                   <div className="flex items-end h-8 space-x-1.5">
                      {[...Array(6)].map((_, i) => (
                        <div 
                          key={i} 
                          className={`w-1 bg-indigo-500 rounded-full transition-all duration-75 ${sessionState === SessionState.CONNECTED ? 'animate-pulse' : ''}`}
                          style={{ height: `${30 + Math.random() * 70}%`, animationDelay: `${i * 150}ms` }}
                        />
                      ))}
                   </div>
                </div>
                <button
                  onClick={handleStopSession}
                  className="w-full py-4 bg-white border border-slate-200 hover:border-rose-100 hover:bg-rose-50 text-slate-500 hover:text-rose-600 rounded-2xl font-semibold text-base transition-all flex items-center justify-center shadow-sm"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  Stop Session
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
