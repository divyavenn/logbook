"""Read the entry limits shared by the editor and API."""
from pathlib import Path
from pydantic import BaseModel, PositiveInt


class EntryPolicy(BaseModel):
    max_depth: PositiveInt
    max_content_length: PositiveInt
    max_tags: PositiveInt
    max_client_id_length: PositiveInt


entry_policy = EntryPolicy.model_validate_json(
    (Path(__file__).resolve().parents[1] / 'shared' / 'entry-policy.json').read_text()
)
