"use client";

import React from "react";
import styles from "../modal-close-button.module.css";

type Props = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children">;

const ModalCloseButton = React.forwardRef<HTMLButtonElement, Props>(function ModalCloseButton(
  { className = "", type = "button", ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={`${styles.button} ${className}`.trim()}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
  );
});

export default ModalCloseButton;
