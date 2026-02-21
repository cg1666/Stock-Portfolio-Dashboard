"use client";

import { useState } from "react";

type TickerInputProps = {
  onAddTicker: (ticker: string) => void;
};

export function TickerInput({ onAddTicker }: TickerInputProps) {
  const [value, setValue] = useState("");

  return (
    <form
      className="panel ticker-form"
      onSubmit={(event) => {
        event.preventDefault();
        onAddTicker(value);
        setValue("");
      }}
    >
      <div className="section-header">
        <h2>Add Ticker</h2>
      </div>
      <div className="ticker-row">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="AAPL"
          aria-label="Ticker symbol"
        />
        <button type="submit" className="primary-button">
          Add
        </button>
      </div>
    </form>
  );
}
