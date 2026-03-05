"use client";
import { useState } from "react";
import styles from "./calendar-user-sync.module.css";

type Producer = {
  email: string;
  password: string;
  fullName: string | null;
  eventTitle: string;
};

export default function CalendarUserSync() {
  const [loading, setLoading] = useState(false);
  const [scannedProducers, setScannedProducers] = useState<Producer[] | null>(null);
  const [result, setResult] = useState<{
    scanned: number;
    created: number;
    alreadyExists: number;
    errors: Array<{ email: string; error: string }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleScan = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setScannedProducers(null);

    try {
      const response = await fetch("/api/admin/sync-calendar-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scan" }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Failed to scan calendar");
        return;
      }

      setScannedProducers(data.producers || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/sync-calendar-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "Failed to create users");
        return;
      }

      setResult(data);
      setScannedProducers(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.section}>
      <h2 className="dashboard-section-title">Add new producers</h2>
      <p className={`muted ${styles.description}`}>
        Scan calendar events and create auth users for producers. Event format: producer-name - radio show name. 
        The producer-name will be used as the password.
      </p>
      
      <button
        className={`dashboard-connect ${styles.scanButton}`}
        onClick={handleScan}
        disabled={loading}
      >
        {loading && !scannedProducers ? "Scanning..." : "Scan Calendar for New Producers"}
      </button>

      {scannedProducers && scannedProducers.length > 0 && (
        <div className={styles.alertBoxWarning}>
          <p className={`${styles.alertTitle} ${styles.alertTitleWarning}`}>
            Found {scannedProducers.length} new producer{scannedProducers.length !== 1 ? "s" : ""} to add:
          </p>
          <div className={styles.scanTableWrapper}>
            <table className={styles.scanTable}>
              <thead className={styles.scanTableHeader}>
                <tr>
                  <th className={styles.scanTableHeaderCell}>Email</th>
                  <th className={styles.scanTableHeaderCell}>Password</th>
                  <th className={styles.scanTableHeaderCell}>From Event</th>
                </tr>
              </thead>
              <tbody>
                {scannedProducers.map((producer, idx) => (
                  <tr key={idx} className={styles.scanTableBody}>
                    <td className={styles.scanTableCell}>{producer.email}</td>
                    <td className={`${styles.scanTableCell} ${styles.scanTablePassword}`}>
                      {producer.password}
                    </td>
                    <td className={`${styles.scanTableCell} ${styles.scanTableEvent}`}>
                      {producer.eventTitle}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            className={`dashboard-connect ${styles.confirmButton} ${styles.confirmButtonGreen}`}
            onClick={handleCreate}
            disabled={loading}
          >
            {loading ? "Creating Users..." : "Confirm & Create Users"}
          </button>
        </div>
      )}

      {scannedProducers && scannedProducers.length === 0 && (
        <div className={styles.alertBoxInfo}>
          <p className={styles.alertText}>No new producers found. All calendar attendees already have accounts.</p>
        </div>
      )}

      {result && (
        <div className={styles.alertBoxSuccess}>
          <p className={`${styles.alertTitle} ${styles.alertTitleSuccess}`}>Sync Complete</p>
          <p className={styles.alertText}>Producers scanned: {result.scanned}</p>
          <p className={styles.alertText}>Users created: {result.created}</p>
          <p className={styles.alertText}>Already exists: {result.alreadyExists}</p>
          {result.errors.length > 0 && (
            <>
              <p className={`${styles.alertTitle} ${styles.alertTitleError}`}>
                Errors: {result.errors.length}
              </p>
              <ul className={styles.alertErrorList}>
                {result.errors.slice(0, 5).map((err, idx) => (
                  <li key={idx} className={styles.alertErrorItem}>
                    {err.email}: {err.error}
                  </li>
                ))}
                {result.errors.length > 5 && (
                  <li className={styles.alertErrorItem}>... and {result.errors.length - 5} more</li>
                )}
              </ul>
            </>
          )}
        </div>
      )}

      {error && (
        <div className={styles.alertBoxError}>
          <p className={`${styles.alertTitle} ${styles.alertTitleError}`}>Error</p>
          <p className={styles.alertText}>{error}</p>
        </div>
      )}
    </div>
  );
}
