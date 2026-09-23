"use client";

import React, { createContext, useContext, useState, useEffect, useRef, useCallback, ReactNode } from "react";

interface SoundContextType {
  playClick: () => void;
  playHover: () => void;
  playToggleOn: () => void;
  playToggleOff: () => void;
  playSuccess: () => void;
  playError: () => void;
  playPop: () => void;
  playWhoosh: () => void;
  isMuted: boolean;
  setIsMuted: (muted: boolean) => void;
  volume: number;
  setVolume: (volume: number) => void;
}

const SoundContext = createContext<SoundContextType | undefined>(undefined);

const STORAGE_KEY = "ui-sounds-settings";

export function SoundProvider({ children }: { children: ReactNode }) {
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(0.3);
  const [isInitialized, setIsInitialized] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);

  // Initialize audio context on first user interaction
  useEffect(() => {
    const initAudio = () => {
      if (!audioContextRef.current) {
        const AudioContextConstructor = window.AudioContext ||
          (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioContextConstructor) {
          audioContextRef.current = new AudioContextConstructor();
        }
      }
    };

    // Load saved settings
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        try {
          const settings = JSON.parse(saved);
          if (typeof settings.isMuted === "boolean") setIsMuted(settings.isMuted);
          if (typeof settings.volume === "number") setVolume(settings.volume);
        } catch (e) {
          console.error("Failed to parse sound settings", e);
        }
      }
      setIsInitialized(true);
    }

    // Initialize on first interaction
    const events = ["click", "keydown", "touchstart"];
    events.forEach(event => document.addEventListener(event, initAudio, { once: true }));

    return () => {
      events.forEach(event => document.removeEventListener(event, initAudio));
    };
  }, []);

  // Save settings
  useEffect(() => {
    if (isInitialized && typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ isMuted, volume }));
    }
  }, [isMuted, volume, isInitialized]);

  // Sound generation functions using Web Audio API
  const playSound = useCallback((
    frequency: number,
    duration: number,
    type: OscillatorType = "sine",
    attack: number = 0.01,
    decay: number = 0.1,
    volumeMultiplier: number = 1
  ) => {
    if (isMuted || !audioContextRef.current) return;

    const ctx = audioContextRef.current;
    if (ctx.state === "suspended") {
      ctx.resume();
    }

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);

    const finalVolume = volume * volumeMultiplier * 0.5;
    
    // ADSR envelope
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(finalVolume, ctx.currentTime + attack);
    gainNode.gain.linearRampToValueAtTime(finalVolume * 0.7, ctx.currentTime + attack + decay);
    gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + duration);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + duration);
  }, [isMuted, volume]);

  // Click sound - short, crisp
  const playClick = useCallback(() => {
    playSound(800, 0.08, "square", 0.001, 0.02, 0.4);
  }, [playSound]);

  // Hover sound - soft, subtle
  const playHover = useCallback(() => {
    playSound(600, 0.05, "sine", 0.005, 0.02, 0.15);
  }, [playSound]);

  // Toggle on - ascending tone
  const playToggleOn = useCallback(() => {
    if (isMuted || !audioContextRef.current) return;

    const ctx = audioContextRef.current;
    if (ctx.state === "suspended") ctx.resume();

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(400, ctx.currentTime);
    oscillator.frequency.linearRampToValueAtTime(800, ctx.currentTime + 0.1);

    const finalVolume = volume * 0.3;
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(finalVolume, ctx.currentTime + 0.01);
    gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.12);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.12);
  }, [isMuted, volume]);

  // Toggle off - descending tone
  const playToggleOff = useCallback(() => {
    if (isMuted || !audioContextRef.current) return;

    const ctx = audioContextRef.current;
    if (ctx.state === "suspended") ctx.resume();

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(800, ctx.currentTime);
    oscillator.frequency.linearRampToValueAtTime(400, ctx.currentTime + 0.1);

    const finalVolume = volume * 0.3;
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(finalVolume, ctx.currentTime + 0.01);
    gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.12);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.12);
  }, [isMuted, volume]);

  // Success sound - pleasant chime
  const playSuccess = useCallback(() => {
    if (isMuted || !audioContextRef.current) return;

    const ctx = audioContextRef.current;
    if (ctx.state === "suspended") ctx.resume();

    const frequencies = [523, 659, 784]; // C5, E5, G5 (C major chord)
    
    frequencies.forEach((freq, i) => {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(freq, ctx.currentTime);

      const finalVolume = volume * 0.2;
      const startTime = ctx.currentTime + i * 0.05;
      
      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(finalVolume, startTime + 0.02);
      gainNode.gain.linearRampToValueAtTime(0, startTime + 0.3);

      oscillator.start(startTime);
      oscillator.stop(startTime + 0.3);
    });
  }, [isMuted, volume]);

  // Error sound - dissonant
  const playError = useCallback(() => {
    if (isMuted || !audioContextRef.current) return;

    const ctx = audioContextRef.current;
    if (ctx.state === "suspended") ctx.resume();

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = "sawtooth";
    oscillator.frequency.setValueAtTime(200, ctx.currentTime);
    oscillator.frequency.linearRampToValueAtTime(150, ctx.currentTime + 0.15);

    const finalVolume = volume * 0.25;
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(finalVolume, ctx.currentTime + 0.01);
    gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.2);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.2);
  }, [isMuted, volume]);

  // Pop sound - bubble pop
  const playPop = useCallback(() => {
    if (isMuted || !audioContextRef.current) return;

    const ctx = audioContextRef.current;
    if (ctx.state === "suspended") ctx.resume();

    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(400, ctx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.1);

    const finalVolume = volume * 0.35;
    gainNode.gain.setValueAtTime(finalVolume, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.1);
  }, [isMuted, volume]);

  // Whoosh sound - swoosh effect
  const playWhoosh = useCallback(() => {
    if (isMuted || !audioContextRef.current) return;

    const ctx = audioContextRef.current;
    if (ctx.state === "suspended") ctx.resume();

    // Create white noise
    const bufferSize = ctx.sampleRate * 0.15;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1000, ctx.currentTime);
    filter.frequency.linearRampToValueAtTime(3000, ctx.currentTime + 0.15);
    filter.Q.value = 1;

    const gainNode = ctx.createGain();
    
    noise.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(ctx.destination);

    const finalVolume = volume * 0.15;
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(finalVolume, ctx.currentTime + 0.02);
    gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.15);

    noise.start(ctx.currentTime);
  }, [isMuted, volume]);

  return (
    <SoundContext.Provider
      value={{
        playClick,
        playHover,
        playToggleOn,
        playToggleOff,
        playSuccess,
        playError,
        playPop,
        playWhoosh,
        isMuted,
        setIsMuted,
        volume,
        setVolume,
      }}
    >
      {children}
    </SoundContext.Provider>
  );
}

export function useSoundContext() {
  const context = useContext(SoundContext);
  if (context === undefined) {
    throw new Error("useSoundContext must be used within a SoundProvider");
  }
  return context;
}

// Hook for components that want to optionally use sounds (won't error if provider is missing)
export function useSound() {
  const context = useContext(SoundContext);
  
  // Return no-op functions if context is not available
  if (!context) {
    return {
      playClick: () => {},
      playHover: () => {},
      playToggleOn: () => {},
      playToggleOff: () => {},
      playSuccess: () => {},
      playError: () => {},
      playPop: () => {},
      playWhoosh: () => {},
      isMuted: true,
      setIsMuted: () => {},
      volume: 0,
      setVolume: () => {},
    };
  }
  
  return context;
}

