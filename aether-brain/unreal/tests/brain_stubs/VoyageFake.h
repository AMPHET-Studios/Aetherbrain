// The rest of the engine slice the Voyage actor (AetherVoyageActor.cpp) uses, shaped after Unreal 5's signatures: procedural meshes that
// check the arrays they are given, textures with a chain of smaller pictures, dynamic materials that remember their parameters, background
// jobs, a PNG reader, the module manager, URL encoding and an actor iterator. Included at the end of FakeUE.h. Not Unreal.
#pragma once

#include <future>

/* ---- math ---------------------------------------------------------------------------------------------------- */

struct FVector2D
{
	double X = 0.0;
	double Y = 0.0;
	FVector2D() = default;
	FVector2D(double InX, double InY) : X(InX), Y(InY) {}
};

constexpr uint32 LOAD_Quiet = 0x2000;
constexpr uint32 LOAD_NoWarn = 0x0100;
constexpr uint32 LOCK_READ_WRITE = 2;

template <class T>
struct TArray64
{
	std::vector<T> V;
	[[nodiscard]] int64 Num() const { return static_cast<int64>(V.size()); }
	[[nodiscard]] T* GetData() { return V.data(); }
	[[nodiscard]] const T* GetData() const { return V.data(); }
	void SetNumUninitialized(int64 N) { V.resize(static_cast<size_t>(N)); }
};

/* ---- assets -------------------------------------------------------------------------------------------------- */

/** What LoadObject finds, by path: the harness puts materials here. */
inline std::map<std::string, UObject*>& GAssets()
{
	static std::map<std::string, UObject*> M;
	return M;
}
template <class T>
T* LoadObject(UObject*, const TCHAR* Path, const TCHAR* = nullptr, uint32 = 0, UObject* = nullptr)
{
	const auto It = GAssets().find(Path);
	return It == GAssets().end() ? nullptr : dynamic_cast<T*>(It->second);
}

class UTexture : public UObject
{
};
enum EPixelFormat { PF_B8G8R8A8 };
enum TextureFilter { TF_Bilinear, TF_Trilinear };
enum TextureAddress { TA_Wrap, TA_Clamp };

struct FByteBulkData
{
	std::vector<uint8> Data;
	bool bLocked = false;
	void* Lock(uint32) { assert(!bLocked); bLocked = true; return Data.data(); }
	void* Realloc(int64 Bytes) { assert(bLocked); Data.resize(static_cast<size_t>(Bytes)); return Data.data(); }
	void Unlock() { assert(bLocked); bLocked = false; }
};
struct FTexture2DMipMap
{
	int32 SizeX = 0;
	int32 SizeY = 0;
	int32 SizeZ = 1;
	FByteBulkData BulkData;
};
template <class T>
struct TIndirectArray
{
	std::vector<std::unique_ptr<T>> V;
	[[nodiscard]] int32 Num() const { return static_cast<int32>(V.size()); }
	int32 Add(T* P) { V.emplace_back(P); return Num() - 1; }
	[[nodiscard]] T& operator[](int32 I) { assert(I >= 0 && I < Num()); return *V[static_cast<size_t>(I)]; }
	[[nodiscard]] const T& operator[](int32 I) const { assert(I >= 0 && I < Num()); return *V[static_cast<size_t>(I)]; }
};
struct FTexturePlatformData
{
	TIndirectArray<FTexture2DMipMap> Mips;
};

class UTexture2D : public UTexture
{
public:
	bool SRGB = true;
	TextureFilter Filter = TF_Bilinear;
	TextureAddress AddressX = TA_Wrap;
	TextureAddress AddressY = TA_Wrap;
	bool NeverStream = false;
	int32 Width = 0;
	int32 Height = 0;
	int UpdateCount = 0;
	FTexturePlatformData PlatformData;
	static UTexture2D* CreateTransient(int32 W, int32 H, EPixelFormat = PF_B8G8R8A8)
	{
		UTexture2D* T = new UTexture2D();
		T->Width = W;
		T->Height = H;
		FTexture2DMipMap* Mip = new FTexture2DMipMap();
		Mip->SizeX = W;
		Mip->SizeY = H;
		Mip->BulkData.Data.assign(static_cast<size_t>(W) * static_cast<size_t>(H) * 4U, 0);
		T->PlatformData.Mips.Add(Mip);
		return T;
	}
	FTexturePlatformData* GetPlatformData() { return &PlatformData; }
	void UpdateResource() { ++UpdateCount; }
};

class UMaterialInstanceDynamic : public UMaterialInterface
{
public:
	UMaterialInterface* Parent = nullptr;
	std::map<std::string, UTexture*> Textures;
	std::map<std::string, float> Scalars;
	std::map<std::string, FLinearColor> Vectors;
	static UMaterialInstanceDynamic* Create(UMaterialInterface* P, UObject*)
	{
		UMaterialInstanceDynamic* M = new UMaterialInstanceDynamic();
		M->Parent = P;
		return M;
	}
	void SetTextureParameterValue(FName N, UTexture* T) { Textures[N.S] = T; }
	void SetScalarParameterValue(FName N, float V) { Scalars[N.S] = V; }
	void SetVectorParameterValue(FName N, const FLinearColor& V) { Vectors[N.S] = V; }
};

/* ---- the procedural mesh ------------------------------------------------------------------------------------- */

struct FProcMeshTangent
{
	FVector TangentX = FVector(1.0, 0.0, 0.0);
	bool bFlipTangentY = false;
	FProcMeshTangent() = default;
	FProcMeshTangent(FVector InTangentX, bool bInFlipTangentY) : TangentX(InTangentX), bFlipTangentY(bInFlipTangentY) {}
};

class UProceduralMeshComponent : public UPrimitiveComponent
{
public:
	struct FSection
	{
		TArray<FVector> Pos;
		TArray<int32> Idx;
		TArray<FVector> Nrm;
		TArray<FVector2D> Uv;
		TArray<FLinearColor> Col;
		TArray<FProcMeshTangent> Tan;
		UMaterialInterface* Material = nullptr;
		bool bCollision = false;
	};
	std::map<int32, FSection> Sections;
	int CreateCalls = 0;
	int ClearCalls = 0;
	std::map<int32, UMaterialInterface*> Materials;

	void CreateMeshSection_LinearColor(int32 SectionIndex, const TArray<FVector>& Vertices, const TArray<int32>& Triangles, const TArray<FVector>& Normals,
		const TArray<FVector2D>& UV0, const TArray<FLinearColor>& VertexColors, const TArray<FProcMeshTangent>& Tangents, bool bCreateCollision)
	{
		// The engine ignores arrays that do not match the vertices and draws a broken mesh; the stand-in refuses them.
		assert(SectionIndex >= 0);
		assert(Triangles.Num() % 3 == 0);
		assert(Normals.Num() == Vertices.Num() && UV0.Num() == Vertices.Num() && VertexColors.Num() == Vertices.Num() && Tangents.Num() == Vertices.Num());
		for (int32 I = 0; I < Triangles.Num(); ++I)
		{
			assert(Triangles[I] >= 0 && Triangles[I] < Vertices.Num());
		}
		++CreateCalls;
		FSection& S = Sections[SectionIndex];
		S.Pos = Vertices;
		S.Idx = Triangles;
		S.Nrm = Normals;
		S.Uv = UV0;
		S.Col = VertexColors;
		S.Tan = Tangents;
		S.bCollision = bCreateCollision;
		const auto It = Materials.find(SectionIndex);
		S.Material = It == Materials.end() ? nullptr : It->second;
	}
	void ClearAllMeshSections() { ++ClearCalls; Sections.clear(); }
	void SetMaterial(int32 Index, UMaterialInterface* M)
	{
		Materials[Index] = M;
		const auto It = Sections.find(Index);
		if (It != Sections.end())
		{
			It->second.Material = M;
		}
	}
	[[nodiscard]] int32 NumSections() const { return static_cast<int32>(Sections.size()); }
};

/* ---- background jobs ----------------------------------------------------------------------------------------- */

enum class EAsyncExecution { TaskGraph, Thread, ThreadPool };

template <class T>
class TFuture
{
public:
	TFuture() = default;
	explicit TFuture(std::shared_future<T> F) : Fut(std::move(F)), bValid(true) {}
	[[nodiscard]] bool IsValid() const { return bValid; }
	[[nodiscard]] bool IsReady() const { return bValid && Fut.wait_for(std::chrono::seconds(0)) == std::future_status::ready; }
	[[nodiscard]] T Get() const { return Fut.get(); }

private:
	std::shared_future<T> Fut;
	bool bValid = false;
};

template <class F>
auto Async(EAsyncExecution, F&& Fn) -> TFuture<decltype(Fn())>
{
	using R = decltype(Fn());
	return TFuture<R>(std::async(std::launch::async, std::forward<F>(Fn)).share());
}

/* ---- PNG, modules, URLs, actors ------------------------------------------------------------------------------ */

enum class EImageFormat { PNG };
enum class ERGBFormat { BGRA };

/** The stand-in "PNG": FPNG, width and height (uint16 little-endian), then nothing: the decoded picture is a gradient. */
class IImageWrapper
{
public:
	bool SetCompressed(const void* Data, int64 Size)
	{
		if (Size < 8) return false;
		const uint8* B = static_cast<const uint8*>(Data);
		if (B[0] != 'F' || B[1] != 'P' || B[2] != 'N' || B[3] != 'G') return false;
		W = B[4] | (B[5] << 8);
		H = B[6] | (B[7] << 8);
		return W > 0 && H > 0;
	}
	bool GetRaw(const ERGBFormat, int32, TArray64<uint8>& Out)
	{
		Out.SetNumUninitialized(static_cast<int64>(W) * H * 4);
		for (int32 Y = 0; Y < H; ++Y)
			for (int32 X = 0; X < W; ++X)
			{
				uint8* P = Out.GetData() + (static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(X)) * 4U;
				P[0] = static_cast<uint8>(X * 255 / std::max(1, W - 1));
				P[1] = static_cast<uint8>(Y * 255 / std::max(1, H - 1));
				P[2] = 128;
				P[3] = 255;
			}
		return true;
	}
	int32 GetWidth() const { return W; }
	int32 GetHeight() const { return H; }

private:
	int32 W = 0;
	int32 H = 0;
};
class IImageWrapperModule
{
public:
	TSharedPtr<IImageWrapper> CreateImageWrapper(EImageFormat) { return MakeShared<IImageWrapper>(); }
};
struct FModuleManager
{
	template <class T>
	static T& LoadModuleChecked(const FName&)
	{
		static T M;
		return M;
	}
};
struct FGenericPlatformHttp
{
	static FString UrlEncode(const FString& In)
	{
		std::string Out;
		for (const unsigned char C : In.S)
		{
			if (std::isalnum(C) || C == '-' || C == '_' || C == '.' || C == '~')
			{
				Out.push_back(static_cast<char>(C));
			}
			else
			{
				char Buf[4];
				std::snprintf(Buf, sizeof(Buf), "%%%02X", C);
				Out += Buf;
			}
		}
		return FString(Out);
	}
};

template <class T>
struct TActorIterator
{
	std::vector<T*> Found;
	size_t I = 0;
	explicit TActorIterator(UWorld* W)
	{
		for (AActor* A : W->Actors)
		{
			if (T* Cast = dynamic_cast<T*>(A))
			{
				Found.push_back(Cast);
			}
		}
	}
	explicit operator bool() const { return I < Found.size(); }
	TActorIterator& operator++() { ++I; return *this; }
	T* operator*() const { return Found[I]; }
};
