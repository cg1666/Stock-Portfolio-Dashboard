"use client";

import { useEffect, useMemo, useState } from "react";
import { PortfolioControls } from "@/components/PortfolioControls";
import { StockComparisonTable } from "@/components/StockComparisonTable";
import { TickerInput } from "@/components/TickerInput";
import { usePortfolioStore } from "@/lib/portfolioStore";
import type { QuotesResponse, StockRow } from "@/lib/types";

const EMPTY_TICKERS: string[] = [];

async function fetchQuotes(tickers: string[]): Promise<QuotesResponse> {
  const query = encodeURIComponent(tickers.join(","));
  const response = await fetch(`/api/quotes?symbols=${query}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to load quote data.");
  }
  return (await response.json()) as QuotesResponse;
}

export function DashboardClient() {
  const [isMounted, setIsMounted] = useState(false);
  const {
    state,
    activePortfolio,
    createPortfolio,
    deletePortfolio,
    setActivePortfolio,
    renamePortfolio,
    addTicker,
    removeTicker,
  } = usePortfolioStore();

  const [rows, setRows] = useState<StockRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const activePortfolioId = activePortfolio?.id ?? "";
  const activeTickers = activePortfolio?.tickers ?? EMPTY_TICKERS;

  useEffect(() => {
    // Render portfolio UI only after mount to avoid server/client HTML mismatches.
    setIsMounted(true);
  }, []);

  const tickerKey = useMemo(() => activeTickers.join(","), [activeTickers]);

  useEffect(() => {
    if (!activePortfolioId) {
      return;
    }

    const tickers = tickerKey ? tickerKey.split(",") : [];
    if (tickers.length === 0) {
      setRows([]);
      setError(null);
      setLastUpdated(null);
      return;
    }

    let isCancelled = false;

    const load = async () => {
      try {
        setIsLoading(true);
        const data = await fetchQuotes(tickers);
        if (isCancelled) {
          return;
        }
        setRows(data.rows);
        setError(null);
        setLastUpdated(data.asOf);
      } catch (fetchError) {
        if (isCancelled) {
          return;
        }
        const message =
          fetchError instanceof Error ? fetchError.message : "Unknown error while loading quotes.";
        setError(message);
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    load();
    const intervalId = window.setInterval(load, 10_000);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activePortfolioId, tickerKey]);

  if (!isMounted || !activePortfolio) {
    return (
      <main className="dashboard-shell">
        <div className="panel">
          <p className="muted-text">Loading your portfolio...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="dashboard-shell">
      <header className="hero">
        <h1>Stock Portfolio Comparison</h1>
        <p>
          Track multiple portfolios and compare indicators side by side with an auto-refreshing
          grid.
        </p>
      </header>

      <PortfolioControls
        portfolios={state.portfolios}
        activePortfolioId={activePortfolio.id}
        activePortfolioName={activePortfolio.name}
        onSelectPortfolio={setActivePortfolio}
        onCreatePortfolio={createPortfolio}
        onRenameActivePortfolio={(name) => {
          renamePortfolio(activePortfolio.id, name);
        }}
        onDeleteActivePortfolio={() => {
          if (
            window.confirm(
              `Delete "${activePortfolio.name}"? This will remove the portfolio and its tickers.`,
            )
          ) {
            deletePortfolio(activePortfolio.id);
          }
        }}
        canDelete={state.portfolios.length > 1}
      />

      <TickerInput onAddTicker={addTicker} />

      <StockComparisonTable
        tickers={activePortfolio.tickers}
        rows={rows}
        isLoading={isLoading}
        error={error}
        onRemoveTicker={removeTicker}
        lastUpdated={lastUpdated}
      />
    </main>
  );
}
