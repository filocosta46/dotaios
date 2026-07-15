import React from 'react'

export default function MacWindow({title, children, className = '', variant = 'dark'}) {
  return (
    <div className={`mac-window mac-window--${variant} ${className}`.trim()}>
      <div className="mac-titlebar">
        <div className="mac-traffic-lights" aria-hidden="true">
          <span className="mac-light mac-light--close" />
          <span className="mac-light mac-light--minimize" />
          <span className="mac-light mac-light--maximize" />
        </div>
        {title ? <span className="mac-titlebar-title">{title}</span> : null}
        <span className="mac-titlebar-spacer" aria-hidden="true" />
      </div>
      <div className="mac-window-content">{children}</div>
    </div>
  )
}
