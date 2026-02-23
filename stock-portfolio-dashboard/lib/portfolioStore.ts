"use client";

import { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "stock-dashboard-portfolios-v1";

export type Portfolio = {
  id: string;
  name: string;
  tickers: string[];
};

type PortfolioState = {
  portfolios: Portfolio[];
  activePortfolioId: string;
};

function defaultPortfolio(): Portfolio {
  return {
    id: crypto.randomUUID(),
    name: "My Portfolio",
    tickers: ["AAPL", "MSFT", "GOOGL"],
  };
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

function getFallbackState(): PortfolioState {
  const fallback = defaultPortfolio();
  return {
    portfolios: [fallback],
    activePortfolioId: fallback.id,
  };
}

function readInitialState(): PortfolioState {
  if (typeof window === "undefined") {
    return getFallbackState();
  }

  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return getFallbackState();
  }

  try {
    const parsed = JSON.parse(raw) as PortfolioState;
    if (!parsed?.portfolios?.length || !parsed.activePortfolioId) {
      return getFallbackState();
    }
    return parsed;
  } catch {
    return getFallbackState();
  }
}

export function usePortfolioStore() {
  const [state, setState] = useState<PortfolioState>(readInitialState);

  useEffect(() => {
    if (!state) {
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const activePortfolio = useMemo(() => {
    return (
      state.portfolios.find((portfolio) => portfolio.id === state.activePortfolioId) ??
      state.portfolios[0]
    );
  }, [state]);

  const createPortfolio = (name: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    setState((prev) => {
      const portfolio: Portfolio = {
        id: crypto.randomUUID(),
        name: trimmedName,
        tickers: [],
      };
      return {
        portfolios: [...prev.portfolios, portfolio],
        activePortfolioId: portfolio.id,
      };
    });
  };

  const deletePortfolio = (portfolioId: string) => {
    setState((prev) => {
      if (prev.portfolios.length === 1) {
        return prev;
      }

      const nextPortfolios = prev.portfolios.filter((portfolio) => portfolio.id !== portfolioId);
      if (nextPortfolios.length === 0) {
        return prev;
      }

      const nextActiveId =
        prev.activePortfolioId === portfolioId ? nextPortfolios[0].id : prev.activePortfolioId;

      return {
        portfolios: nextPortfolios,
        activePortfolioId: nextActiveId,
      };
    });
  };

  const setActivePortfolio = (portfolioId: string) => {
    setState((prev) => ({ ...prev, activePortfolioId: portfolioId }));
  };

  const renamePortfolio = (portfolioId: string, name: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    setState((prev) => ({
      ...prev,
      portfolios: prev.portfolios.map((portfolio) =>
        portfolio.id === portfolioId ? { ...portfolio, name: trimmedName } : portfolio,
      ),
    }));
  };

  const addTicker = (tickerInput: string) => {
    const ticker = normalizeTicker(tickerInput);
    if (!ticker) {
      return;
    }

    setState((prev) => {
      return {
        ...prev,
        portfolios: prev.portfolios.map((portfolio) => {
          if (portfolio.id !== prev.activePortfolioId) {
            return portfolio;
          }
          // Keep symbols unique so the comparison table stays clean.
          const deduped = Array.from(new Set([...portfolio.tickers, ticker]));
          return { ...portfolio, tickers: deduped };
        }),
      };
    });
  };

  const removeTicker = (tickerInput: string) => {
    const ticker = normalizeTicker(tickerInput);
    if (!ticker) {
      return;
    }

    setState((prev) => {
      return {
        ...prev,
        portfolios: prev.portfolios.map((portfolio) => {
          if (portfolio.id !== prev.activePortfolioId) {
            return portfolio;
          }
          return {
            ...portfolio,
            tickers: portfolio.tickers.filter((symbol) => symbol !== ticker),
          };
        }),
      };
    });
  };

  return {
    state,
    activePortfolio,
    createPortfolio,
    deletePortfolio,
    setActivePortfolio,
    renamePortfolio,
    addTicker,
    removeTicker,
  };
}
