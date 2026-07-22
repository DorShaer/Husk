"use client";

import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

interface ObserverModeContextValue {
  observerMode: boolean;
  toggleObserverMode: () => void;
}

const ObserverModeContext = createContext<ObserverModeContextValue>({
  observerMode: false,
  toggleObserverMode: () => {},
});

export function ObserverModeProvider({ children }: { children: ReactNode }) {
  const [observerMode, setObserverMode] = useState(false);

  useEffect(() => {
    if (observerMode) {
      document.body.classList.add("observer-active");
    } else {
      document.body.classList.remove("observer-active");
    }
  }, [observerMode]);

  const toggleObserverMode = () => setObserverMode((prev) => !prev);

  return (
    <ObserverModeContext.Provider value={{ observerMode, toggleObserverMode }}>
      {children}
    </ObserverModeContext.Provider>
  );
}

export function useObserverMode() {
  return useContext(ObserverModeContext);
}
