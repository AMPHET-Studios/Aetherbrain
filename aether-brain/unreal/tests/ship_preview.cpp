// A software picture of the ships and their metal, made from the very same arrays the viewer hands to Unreal
// (AetherShipMath.h): a z-buffered triangle rasteriser with perspective-correct pictures, normal mapping, a GGX
// highlight, emissive lights and a filmic shoulder. A check and a preview, not the renderer: Unreal draws the real thing
// with its own lights. Run with unreal/tests/ship_preview.sh <output folder> [map size].
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherShipMath.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <string>

using namespace AetherShip;
using AetherSpace::ToSrgb8;

namespace
{
using Clock = std::chrono::steady_clock;

double Since(Clock::time_point T)
{
	return std::chrono::duration<double>(Clock::now() - T).count();
}

void WritePpm(const std::string& Path, int W, int H, const std::vector<uint8_t>& Rgb8)
{
	std::FILE* F = std::fopen(Path.c_str(), "wb");
	if (!F)
	{
		std::printf("cannot write %s\n", Path.c_str());
		return;
	}
	std::fprintf(F, "P6\n%d %d\n255\n", W, H);
	std::fwrite(Rgb8.data(), 1, Rgb8.size(), F);
	std::fclose(F);
}

double SrgbToLin(uint8_t V)
{
	static std::vector<double> T;
	if (T.empty())
	{
		for (int I = 0; I < 256; ++I)
		{
			T.push_back(AetherSky::Srgb8ToLinear(static_cast<double>(I) / 255.0));
		}
	}
	return T[V];
}

/** Bilinear, wrapping. */
Rgb Sample(const Image& I, double U, double V, bool bSrgb)
{
	const double X = (U - std::floor(U)) * I.Width - 0.5;
	const double Y = (V - std::floor(V)) * I.Height - 0.5;
	const int X0 = static_cast<int>(std::floor(X));
	const int Y0 = static_cast<int>(std::floor(Y));
	const double Fx = X - X0;
	const double Fy = Y - Y0;
	auto At = [&](int Px, int Py) {
		Px = ((Px % I.Width) + I.Width) % I.Width;
		Py = ((Py % I.Height) + I.Height) % I.Height;
		const size_t O = I.Offset(Px, Py);
		if (bSrgb)
		{
			return Rgb{SrgbToLin(I.Bgra[O + 2]), SrgbToLin(I.Bgra[O + 1]), SrgbToLin(I.Bgra[O + 0])};
		}
		return Rgb{I.Bgra[O + 2] / 255.0, I.Bgra[O + 1] / 255.0, I.Bgra[O + 0] / 255.0};
	};
	const Rgb A = AetherSky::LerpRgb(At(X0, Y0), At(X0 + 1, Y0), Fx);
	const Rgb B = AetherSky::LerpRgb(At(X0, Y0 + 1), At(X0 + 1, Y0 + 1), Fx);
	return AetherSky::LerpRgb(A, B, Fy);
}

struct Camera
{
	Vec3 Pos;
	Vec3 Fwd;
	Vec3 Right;
	Vec3 Up;
	double Focal;
	int W;
	int H;
	Camera(const Vec3& P, const Vec3& LookAt, int W_, int H_, double HFovDeg) : Pos(P), W(W_), H(H_)
	{
		Fwd = AetherSpace::Normalized(LookAt - P);
		Right = AetherSpace::Normalized(AetherSpace::Cross(AetherSpace::kUp, Fwd), Vec3{0.0, 1.0, 0.0});
		Up = AetherSpace::Cross(Fwd, Right);
		Focal = 0.5 * static_cast<double>(W_) / std::tan(AetherSpace::DegToRad(HFovDeg) * 0.5);
	}
	Vec3 ToView(const Vec3& P) const
	{
		const Vec3 D = P - Pos;
		return Vec3{AetherSpace::Dot(D, Right), AetherSpace::Dot(D, Up), AetherSpace::Dot(D, Fwd)};
	}
};

struct Sample4
{
	float Depth = 1e30F;
	int Zone = -1;
	uint32_t Tri = 0;
	float B0 = 0.0F;
	float B1 = 0.0F;
	float B2 = 0.0F;
};

Rgb Env(const Vec3& R, const Vec3& L)
{
	const double Up = std::max(0.0, R.Z) * 0.5 + 0.5;
	// A dim nebula-lit sky with a sun.
	const double Sun = std::pow(std::max(0.0, AetherSpace::Dot(R, L)), 600.0) * 60.0 + std::pow(std::max(0.0, AetherSpace::Dot(R, L)), 24.0) * 0.6;
	return Rgb{0.018 + 0.02 * Up + Sun, 0.022 + 0.026 * Up + Sun * 0.93, 0.04 + 0.05 * Up + Sun * 0.80};
}

struct Scene
{
	const Mesh* M;
	const HullMaps* Maps;
	Vec3 Light;
};

/** Renders at 2x and averages down. Returns sRGB bytes. */
std::vector<uint8_t> Render(const Scene& S, const Camera& Cam, double Exposure)
{
	const int SS = 2;
	const int W = Cam.W * SS;
	const int H = Cam.H * SS;
	std::vector<Sample4> Buf(static_cast<size_t>(W) * static_cast<size_t>(H));
	const double Focal = Cam.Focal * SS;
	for (int Z = 0; Z < kZones; ++Z)
	{
		const Section& Sec = S.M->Z[static_cast<size_t>(Z)];
		std::vector<Vec3> V(Sec.Pos.size());
		for (size_t I = 0; I < Sec.Pos.size(); ++I)
		{
			V[I] = Cam.ToView(Sec.Pos[I]);
		}
		for (size_t T = 0; T + 2U < Sec.Idx.size(); T += 3U)
		{
			const uint32_t Ia = Sec.Idx[T];
			const uint32_t Ib = Sec.Idx[T + 1U];
			const uint32_t Ic = Sec.Idx[T + 2U];
			const Vec3& A = V[Ia];
			const Vec3& B = V[Ib];
			const Vec3& C = V[Ic];
			if (A.Z < 0.5 || B.Z < 0.5 || C.Z < 0.5)
			{
				continue;
			}
			// Back faces are not drawn: Unreal culls them too.
			const Vec3 N = AetherSpace::Cross(Sec.Pos[Ib] - Sec.Pos[Ia], Sec.Pos[Ic] - Sec.Pos[Ia]);
			if (AetherSpace::Dot(N, Cam.Pos - Sec.Pos[Ia]) <= 0.0)
			{
				continue;
			}
			auto Sx = [&](const Vec3& P) { return static_cast<double>(W) * 0.5 + P.X / P.Z * Focal; };
			auto Sy = [&](const Vec3& P) { return static_cast<double>(H) * 0.5 - P.Y / P.Z * Focal; };
			const double X0 = Sx(A);
			const double Y0 = Sy(A);
			const double X1 = Sx(B);
			const double Y1 = Sy(B);
			const double X2 = Sx(C);
			const double Y2 = Sy(C);
			const double Area = (X1 - X0) * (Y2 - Y0) - (X2 - X0) * (Y1 - Y0);
			if (std::fabs(Area) < 1e-9)
			{
				continue;
			}
			const int MinX = std::max(0, static_cast<int>(std::floor(std::min(X0, std::min(X1, X2)))));
			const int MaxX = std::min(W - 1, static_cast<int>(std::ceil(std::max(X0, std::max(X1, X2)))));
			const int MinY = std::max(0, static_cast<int>(std::floor(std::min(Y0, std::min(Y1, Y2)))));
			const int MaxY = std::min(H - 1, static_cast<int>(std::ceil(std::max(Y0, std::max(Y1, Y2)))));
			for (int Y = MinY; Y <= MaxY; ++Y)
			{
				for (int X = MinX; X <= MaxX; ++X)
				{
					const double Px = X + 0.5;
					const double Py = Y + 0.5;
					const double W0 = ((X1 - Px) * (Y2 - Py) - (X2 - Px) * (Y1 - Py)) / Area;
					const double W1 = ((X2 - Px) * (Y0 - Py) - (X0 - Px) * (Y2 - Py)) / Area;
					const double W2 = 1.0 - W0 - W1;
					if (W0 < 0.0 || W1 < 0.0 || W2 < 0.0)
					{
						continue;
					}
					// Perspective-correct weights and depth.
					const double Iw0 = W0 / A.Z;
					const double Iw1 = W1 / B.Z;
					const double Iw2 = W2 / C.Z;
					const double Sum = Iw0 + Iw1 + Iw2;
					const double Depth = 1.0 / Sum;
					Sample4& D = Buf[static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(X)];
					if (Depth < static_cast<double>(D.Depth))
					{
						D.Depth = static_cast<float>(Depth);
						D.Zone = Z;
						D.Tri = static_cast<uint32_t>(T);
						D.B0 = static_cast<float>(Iw0 * Depth);
						D.B1 = static_cast<float>(Iw1 * Depth);
						D.B2 = static_cast<float>(Iw2 * Depth);
					}
				}
			}
		}
	}
	std::vector<Rgb> Lin(static_cast<size_t>(W) * static_cast<size_t>(H));
	const Vec3 L = S.Light;
	const Vec3 L2 = AetherSpace::Normalized(Vec3{0.5, 0.7, -0.2});
	const Rgb KeyCol{3.1, 2.85, 2.5};
	const Rgb FillCol{0.20, 0.28, 0.50};
	AetherSky::ParallelRows(H, [&](int Y) {
		for (int X = 0; X < W; ++X)
		{
			const Sample4& D = Buf[static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(X)];
			Rgb Out{0.0, 0.0, 0.0};
			if (D.Zone < 0)
			{
				Lin[static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(X)] = Out;
				continue;
			}
			const Section& Sec = S.M->Z[static_cast<size_t>(D.Zone)];
			const uint32_t Ia = Sec.Idx[D.Tri];
			const uint32_t Ib = Sec.Idx[D.Tri + 1U];
			const uint32_t Ic = Sec.Idx[D.Tri + 2U];
			const double B0 = static_cast<double>(D.B0);
			const double B1 = static_cast<double>(D.B1);
			const double B2 = static_cast<double>(D.B2);
			const auto Mix3 = [&](const Vec3& A, const Vec3& B, const Vec3& C) { return A * B0 + B * B1 + C * B2; };
			const Vec3 P = Mix3(Sec.Pos[Ia], Sec.Pos[Ib], Sec.Pos[Ic]);
			Vec3 N = AetherSpace::Normalized(Mix3(Sec.Nrm[Ia], Sec.Nrm[Ib], Sec.Nrm[Ic]));
			const Vec3 T0 = AetherSpace::Normalized(Mix3(Sec.Tan[Ia], Sec.Tan[Ib], Sec.Tan[Ic]));
			const double U = Sec.Uv[Ia].U * B0 + Sec.Uv[Ib].U * B1 + Sec.Uv[Ic].U * B2;
			const double Vv = Sec.Uv[Ia].V * B0 + Sec.Uv[Ib].V * B1 + Sec.Uv[Ic].V * B2;
			const Rgb Col = Sec.Col[Ia] * B0 + Sec.Col[Ib] * B1 + Sec.Col[Ic] * B2;
			const Vec3 View = AetherSpace::Normalized(Cam.Pos - P);
			if (D.Zone == static_cast<int>(Zone::Light))
			{
				Lin[static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(X)] = Col;
				continue;
			}
			Rgb Albedo{0.02, 0.025, 0.03};
			double Rough = 0.06;
			double Metal = 0.0;
			double Ao = 1.0;
			if (D.Zone == static_cast<int>(Zone::Hull))
			{
				const Rgb Base = Sample(S.Maps->BaseColor, U, Vv, true);
				Albedo = AetherSky::Mul(Base, Col);
				const Rgb Orm = Sample(S.Maps->Orm, U, Vv, false);
				Ao = Orm.R;
				Rough = std::max(0.04, Orm.G);
				Metal = Orm.B;
				const Rgb Nm = Sample(S.Maps->Normal, U, Vv, false);
				const Vec3 Tn = AetherSpace::Normalized(Vec3{Nm.R * 2.0 - 1.0, Nm.G * 2.0 - 1.0, Nm.B * 2.0 - 1.0});
				const Vec3 Tt = AetherSpace::Normalized(T0 - N * AetherSpace::Dot(T0, N));
				const Vec3 Bt = AetherSpace::Cross(N, Tt);
				N = AetherSpace::Normalized(Tt * Tn.X + Bt * Tn.Y + N * Tn.Z);
			}
			const Rgb F0 = AetherSky::LerpRgb(Rgb{0.04, 0.04, 0.04}, Albedo, Metal);
			const Rgb Diff = Albedo * (1.0 - Metal);
			auto Shade = [&](const Vec3& Ld, const Rgb& Radiance) {
				const double Nl = std::max(0.0, AetherSpace::Dot(N, Ld));
				const Vec3 Hv = AetherSpace::Normalized(Ld + View);
				const double Nh = std::max(0.0, AetherSpace::Dot(N, Hv));
				const double Vh = std::max(0.0, AetherSpace::Dot(View, Hv));
				const double A2 = std::pow(std::max(0.03, Rough), 4.0);
				const double Dd = Nh * Nh * (A2 - 1.0) + 1.0;
				const double Dist = A2 / (AetherSpace::kPi * Dd * Dd);
				const double Nv = std::max(1e-3, AetherSpace::Dot(N, View));
				const double K = (Rough + 1.0) * (Rough + 1.0) / 8.0;
				const double Gv = Nl / (Nl * (1.0 - K) + K) * (Nv / (Nv * (1.0 - K) + K));
				const double Fr = std::pow(1.0 - Vh, 5.0);
				const Rgb F = F0 + (Rgb{1.0, 1.0, 1.0} + F0 * -1.0) * Fr;
				const Rgb Spec = F * (Dist * Gv / std::max(1e-3, 4.0 * Nl * Nv + 1e-4) * Nl);
				return AetherSky::Mul(Radiance, Diff * (Nl / AetherSpace::kPi) + Spec);
			};
			Out = Shade(L, KeyCol) + Shade(L2, FillCol);
			// Ambient light from the dim sky (diffuse) and its reflection (specular, a fresnel at grazing angles).
			const Vec3 Rf = N * (2.0 * AetherSpace::Dot(N, View)) - View;
			const double Fr = std::pow(1.0 - std::max(0.0, AetherSpace::Dot(N, View)), 5.0);
			const Rgb Ref = Env(Rf, L);
			const Rgb EnvSpec = AetherSky::Mul(F0 + (Rgb{1.0, 1.0, 1.0} + F0 * -1.0) * (Fr * (1.0 - Rough)), Ref);
			Out = Out + AetherSky::Mul(Diff, Rgb{0.030, 0.036, 0.055}) * Ao + EnvSpec * Ao * (1.0 - 0.55 * Rough);
			if (D.Zone == static_cast<int>(Zone::Glass))
			{
				Out = Out + Ref * 0.9;
			}
			Lin[static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(X)] = Out;
		}
	});
	std::vector<uint8_t> Out(static_cast<size_t>(Cam.W) * static_cast<size_t>(Cam.H) * 3U);
	// Bloom of the very bright (lights, plasma) and the filmic shoulder.
	std::vector<Rgb> Small(static_cast<size_t>(Cam.W) * static_cast<size_t>(Cam.H));
	for (int Y = 0; Y < Cam.H; ++Y)
	{
		for (int X = 0; X < Cam.W; ++X)
		{
			Rgb Acc{};
			for (int Dy = 0; Dy < SS; ++Dy)
			{
				for (int Dx = 0; Dx < SS; ++Dx)
				{
					const Rgb C = Lin[static_cast<size_t>(Y * SS + Dy) * static_cast<size_t>(W) + static_cast<size_t>(X * SS + Dx)];
					// Clamp each sample so one hot pixel cannot hide an edge.
					Acc = Acc + Rgb{std::min(C.R, 20.0), std::min(C.G, 20.0), std::min(C.B, 20.0)};
				}
			}
			Small[static_cast<size_t>(Y) * static_cast<size_t>(Cam.W) + static_cast<size_t>(X)] = Acc * (1.0 / (SS * SS));
		}
	}
	std::vector<Rgb> Glow(Small.size(), Rgb{});
	for (size_t I = 0; I < Small.size(); ++I)
	{
		Glow[I] = Rgb{std::max(0.0, Small[I].R - 1.2), std::max(0.0, Small[I].G - 1.2), std::max(0.0, Small[I].B - 1.2)};
	}
	const auto Blur = [&](const std::vector<Rgb>& In, int Radius) {
		std::vector<Rgb> Tmp(In.size());
		std::vector<Rgb> Dst(In.size());
		for (int Y = 0; Y < Cam.H; ++Y)
		{
			for (int X = 0; X < Cam.W; ++X)
			{
				Rgb A{};
				for (int K = -Radius; K <= Radius; ++K)
				{
					A = A + In[static_cast<size_t>(Y) * static_cast<size_t>(Cam.W) + static_cast<size_t>(std::max(0, std::min(Cam.W - 1, X + K)))];
				}
				Tmp[static_cast<size_t>(Y) * static_cast<size_t>(Cam.W) + static_cast<size_t>(X)] = A * (1.0 / (2 * Radius + 1));
			}
		}
		for (int Y = 0; Y < Cam.H; ++Y)
		{
			for (int X = 0; X < Cam.W; ++X)
			{
				Rgb A{};
				for (int K = -Radius; K <= Radius; ++K)
				{
					A = A + Tmp[static_cast<size_t>(std::max(0, std::min(Cam.H - 1, Y + K))) * static_cast<size_t>(Cam.W) + static_cast<size_t>(X)];
				}
				Dst[static_cast<size_t>(Y) * static_cast<size_t>(Cam.W) + static_cast<size_t>(X)] = A * (1.0 / (2 * Radius + 1));
			}
		}
		return Dst;
	};
	const std::vector<Rgb> G1 = Blur(Glow, 6);
	const std::vector<Rgb> G2 = Blur(Glow, 22);
	for (size_t I = 0; I < Small.size(); ++I)
	{
		const Rgb C = Small[I] + G1[I] * 0.7 + G2[I] * 1.3;
		const double Rs[3] = {C.R * Exposure, C.G * Exposure, C.B * Exposure};
		for (int K = 0; K < 3; ++K)
		{
			const double X = Rs[K];
			const double Mapped = (X * (2.51 * X + 0.03)) / (X * (2.43 * X + 0.59) + 0.14);
			Out[I * 3U + static_cast<size_t>(K)] = ToSrgb8(Mapped);
		}
	}
	return Out;
}

/** A crop of a map at one pixel per pixel, as sRGB bytes. */
std::vector<uint8_t> Crop(const Image& I, int X0, int Y0, int W, int H)
{
	std::vector<uint8_t> Out(static_cast<size_t>(W) * static_cast<size_t>(H) * 3U);
	for (int Y = 0; Y < H; ++Y)
	{
		for (int X = 0; X < W; ++X)
		{
			const size_t O = I.Offset((X0 + X) % I.Width, (Y0 + Y) % I.Height);
			const size_t P = (static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(X)) * 3U;
			Out[P + 0] = I.Bgra[O + 2];
			Out[P + 1] = I.Bgra[O + 1];
			Out[P + 2] = I.Bgra[O + 0];
		}
	}
	return Out;
}
} // namespace

int main(int Argc, char** Argv)
{
	const std::string Out = Argc > 1 ? Argv[1] : "./ship_preview";
	const int MapSize = Argc > 2 ? std::atoi(Argv[2]) : 2048;
	Clock::time_point T = Clock::now();
	const HullMaps Maps = MakeHullMaps(MapSize, 77U, LiveryOf(0));
	std::printf("hull maps %d: %.1f s\n", MapSize, Since(T));
	WritePpm(Out + "/hull_albedo_crop.ppm", 1024, 1024, Crop(Maps.BaseColor, 0, 0, 1024, 1024));
	WritePpm(Out + "/hull_normal_crop.ppm", 1024, 1024, Crop(Maps.Normal, 0, 0, 1024, 1024));
	WritePpm(Out + "/hull_orm_crop.ppm", 1024, 1024, Crop(Maps.Orm, 0, 0, 1024, 1024));
	// The whole albedo, small.
	{
		const int Step = std::max(1, MapSize / 1024);
		std::vector<uint8_t> Small(static_cast<size_t>(1024) * 1024U * 3U);
		for (int Y = 0; Y < 1024; ++Y)
		{
			for (int X = 0; X < 1024; ++X)
			{
				const size_t O = Maps.BaseColor.Offset(std::min(MapSize - 1, X * Step), std::min(MapSize - 1, Y * Step));
				const size_t P = (static_cast<size_t>(Y) * 1024U + static_cast<size_t>(X)) * 3U;
				Small[P + 0] = Maps.BaseColor.Bgra[O + 2];
				Small[P + 1] = Maps.BaseColor.Bgra[O + 1];
				Small[P + 2] = Maps.BaseColor.Bgra[O + 0];
			}
		}
		WritePpm(Out + "/hull_albedo_tile.ppm", 1024, 1024, Small);
	}
	struct View
	{
		const char* Name;
		ShipClass Cls;
		uint32_t Seed;
		Vec3 Dir; // from the ship to the camera, in units of the ship's length
		double Fov;
		double Dist;
		Vec3 Target;
		double Exposure;
	};
	const View Views[] = {
		{"interceptor_front34", ShipClass::Interceptor, 7U, Vec3{0.80, -0.62, 0.28}, 40.0, 1.25, Vec3{0.0, 0.0, 0.0}, 0.9},
		{"interceptor_rear", ShipClass::Interceptor, 7U, Vec3{-0.85, -0.35, 0.18}, 40.0, 1.15, Vec3{0.0, 0.0, 0.0}, 0.9},
		{"interceptor_top", ShipClass::Interceptor, 11U, Vec3{0.12, -0.22, 0.97}, 40.0, 1.15, Vec3{0.0, 0.0, 0.0}, 0.9},
		{"hauler_front34", ShipClass::Hauler, 3U, Vec3{0.78, -0.55, 0.30}, 38.0, 1.75, Vec3{0.0, 0.0, 0.0}, 0.9},
		{"hauler_rear", ShipClass::Hauler, 3U, Vec3{-0.8, -0.45, 0.25}, 38.0, 1.6, Vec3{-0.05, 0.0, 0.0}, 0.9},
		{"cruiser_front34", ShipClass::Cruiser, 5U, Vec3{0.72, -0.62, 0.30}, 40.0, 1.5, Vec3{0.0, 0.0, 0.0}, 0.9},
	};
	for (const View& V : Views)
	{
		T = Clock::now();
		const Mesh M = MakeShip(V.Cls, V.Seed);
		const double Len = ShipLength(V.Cls);
		const Vec3 Target = V.Target * Len;
		const Vec3 Eye = Target + AetherSpace::Normalized(V.Dir) * (V.Dist * Len);
		const Camera Cam(Eye, Target, 1600, 900, V.Fov);
		const Scene S{&M, &Maps, AetherSpace::Normalized(Vec3{0.45, -0.65, 0.62})};
		const std::vector<uint8_t> Px = Render(S, Cam, V.Exposure);
		WritePpm(Out + "/" + V.Name + ".ppm", 1600, 900, Px);
		std::printf("%s: %zu tris, %.1f s\n", V.Name, M.Triangles(), Since(T));
	}
	return 0;
}
