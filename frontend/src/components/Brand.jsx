export default function Brand({ compact = false }) {
    return (
        <div className={`brand ${compact ? 'brand--compact' : ''}`}>
            <span className="brand__mark" aria-hidden="true">
                <svg viewBox="0 0 32 32" role="img">
                    <path d="M7 21.5 13.2 15l4.1 4.1L25 10.5" />
                    <path d="M19 10.5h6v6" />
                </svg>
            </span>
            <span>Crypto Info</span>
        </div>
    );
}
