"""Configuration for the BWS Risk MCP server."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

CONFIG_DIR = Path.home() / ".bws-risk-mcp"
CONFIG_FILE = CONFIG_DIR / "config.json"

DEFAULT_BASE_URL = "https://dms.byrnewallace.com"


@dataclass
class Config:
    base_url: str = DEFAULT_BASE_URL
    api_version: str = "v2"
    auth_method: str = "negotiate"  # negotiate | ntlm | kerberos
    verify_ssl: bool = True
    timeout_seconds: int = 30
    max_results: int = 500
    libraries: list[str] = field(default_factory=list)

    @property
    def api_base(self) -> str:
        return f"{self.base_url}/work/api/{self.api_version}"

    def save(self) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        CONFIG_FILE.write_text(
            json.dumps(
                {
                    "base_url": self.base_url,
                    "api_version": self.api_version,
                    "auth_method": self.auth_method,
                    "verify_ssl": self.verify_ssl,
                    "timeout_seconds": self.timeout_seconds,
                    "max_results": self.max_results,
                    "libraries": self.libraries,
                },
                indent=2,
            )
        )

    @classmethod
    def load(cls) -> Config:
        if CONFIG_FILE.exists():
            data = json.loads(CONFIG_FILE.read_text())
            return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})
        return cls()
