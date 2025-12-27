
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { TranscriptionMessage, SessionState } from './types';
import { decode, encode, decodeAudioData, createBlobFromPCM } from './utils/audio';

// System prompt as provided in the instructions
const SYSTEM_PROMPT = `Role: You are "Professor Claire," a patient, encouraging, and highly observant English as a Second Language (ESL) teacher. Your goal is to help me improve my conversational English through natural dialogue.

Instructional Style:
1. Active Listening: Listen closely to everything I say. Do not ignore errors.
2. Instant Correction: If I make a grammatical mistake or use an awkward phrase, gently interrupt or wait for the end of my sentence to provide the correct version.
3. Pronunciation Focus: Pay special attention to my pronunciation. If I mispronounce a word, say: "Wait, let's try that word again. It’s pronounced [Phonetic Spelling]. Try saying it back to me."
4. Natural Flow: After correcting me, keep the conversation going by asking a follow-up question related to our topic.

Tone and Voice:
- Warm, professional, and supportive.
- Speak at a moderate pace—not too fast, but not so slow that it feels unnatural.
- Use "Encouraging Reinforcement" (e.g., "That was a great use of the past tense! Now, let's look at...").

Rules for Correction:
- Grammar: Fix tense shifts, subject-verb agreement, and preposition errors.
- Vocabulary: Suggest "better" or "more natural" words if basic words are repeated.
- Feedback Loop: If I make a mistake, explain why it was wrong in one brief sentence before moving on.`;

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
            // Handle transcriptions
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

            // Handle audio
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
            setErrorMessage("Connection lost. Please check your internet and try again.");
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
      setErrorMessage(err.message || "Could not connect to Professor Claire.");
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
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 leading-tight">Professor Claire</h1>
              <p className="text-sm text-indigo-600 font-medium">Your Patient ESL Tutor</p>
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
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-slate-700">Welcome to Professor Claire's Classroom</h3>
                <p className="text-slate-500 max-w-sm text-sm">
                  Click the button below to start a voice conversation. She'll help you with grammar, pronunciation, and vocabulary in real-time.
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
                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
               </div>
            )}
          </div>

          {/* Error Message */}
          {errorMessage && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 w-4/5">
              <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-2 rounded-xl text-xs flex items-center space-x-2">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>{errorMessage}</span>
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
                className="group relative flex items-center justify-center w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-semibold text-lg transition-all shadow-xl shadow-indigo-200 hover:shadow-indigo-300 active:scale-[0.98]"
              >
                <span className="mr-2">Enter the Classroom</span>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </button>
            ) : (
              <div className="w-full space-y-4">
                <div className="flex items-center justify-center space-x-4">
                   {/* Speaking Visualizer (Static placeholder) */}
                   <div className="flex items-end h-8 space-x-1 px-4">
                      {[...Array(8)].map((_, i) => (
                        <div 
                          key={i} 
                          className={`w-1.5 bg-indigo-400 rounded-full ${sessionState === SessionState.CONNECTED ? 'animate-pulse' : ''}`}
                          style={{ height: `${20 + Math.random() * 80}%`, animationDelay: `${i * 100}ms` }}
                        />
                      ))}
                   </div>
                </div>
                <button
                  onClick={handleStopSession}
                  className="w-full py-4 bg-white border-2 border-slate-200 hover:border-rose-200 hover:bg-rose-50 text-slate-600 hover:text-rose-600 rounded-2xl font-semibold text-lg transition-all flex items-center justify-center"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  End Lesson
                </button>
              </div>
            )}
            
            <p className="mt-4 text-[10px] uppercase tracking-widest font-bold text-slate-400">
              Powered by Gemini 2.5 Live
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
