"use client";

import React from "react";
import styles from "../icon-action-button.module.css";

type Props = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  label: string;
  icon: React.ReactNode;
};

export default function IconActionButton({ label, icon, type = "button", ...props }: Props) {
  return (
    <button
      {...props}
      type={type}
      className={`${styles.button} ${props.className || ""}`.trim()}
      data-tooltip={label}
      aria-label={props["aria-label"] || label}
    >
      {icon}
    </button>
  );
}
