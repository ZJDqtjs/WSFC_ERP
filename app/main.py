from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from .auth import ensure_seed_users
from .database import Base, DATA_DIR, SessionLocal, engine
from .routers import auth, imports, inbound, inventory, outbound, products, report
from .services import seed_units

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


def migrate():
    """轻量迁移：为已存在的库补充新增列。"""
    with engine.connect() as conn:
        cols = [r[1] for r in conn.execute(text("PRAGMA table_info(products)")).fetchall()]
        if "code" not in cols:
            conn.execute(text("ALTER TABLE products ADD COLUMN code VARCHAR(128) DEFAULT ''"))
        conn.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    migrate()
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        seed_units(db)
        ensure_seed_users(db)
    finally:
        db.close()
    yield


app = FastAPI(title="企业台账系统", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(products.router)
app.include_router(inbound.router)
app.include_router(outbound.router)
app.include_router(inventory.router)
app.include_router(report.router)
app.include_router(imports.router)

app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
