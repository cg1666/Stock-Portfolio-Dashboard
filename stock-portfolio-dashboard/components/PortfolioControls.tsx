"use client";

import type { Portfolio } from "@/lib/portfolioStore";

type PortfolioControlsProps = {
  portfolios: Portfolio[];
  activePortfolioId: string;
  activePortfolioName: string;
  onSelectPortfolio: (portfolioId: string) => void;
  onCreatePortfolio: (name: string) => void;
  onRenameActivePortfolio: (name: string) => void;
  onDeleteActivePortfolio: () => void;
  canDelete: boolean;
};

export function PortfolioControls({
  portfolios,
  activePortfolioId,
  activePortfolioName,
  onSelectPortfolio,
  onCreatePortfolio,
  onRenameActivePortfolio,
  onDeleteActivePortfolio,
  canDelete,
}: PortfolioControlsProps) {
  return (
    <section className="panel">
      <div className="section-header">
        <h2>Portfolios</h2>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            const name = window.prompt("Portfolio name");
            if (name) {
              onCreatePortfolio(name);
            }
          }}
        >
          New Portfolio
        </button>
      </div>

      <div className="portfolio-row">
        <label htmlFor="portfolio-select">Active</label>
        <select
          id="portfolio-select"
          value={activePortfolioId}
          onChange={(event) => onSelectPortfolio(event.target.value)}
        >
          {portfolios.map((portfolio) => (
            <option key={portfolio.id} value={portfolio.id}>
              {portfolio.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            const name = window.prompt("Rename portfolio", activePortfolioName);
            if (name) {
              onRenameActivePortfolio(name);
            }
          }}
        >
          Rename
        </button>
        <button
          type="button"
          className="danger-button"
          onClick={onDeleteActivePortfolio}
          disabled={!canDelete}
        >
          Delete
        </button>
      </div>
    </section>
  );
}
